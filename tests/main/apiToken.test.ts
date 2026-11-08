import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiAuth, withSignOutOn401, VERIFY_URL, ZONES_PROBE_URL } from '../../src/zonekeeper/main/auth/apiToken'
import {
  EncryptionUnavailableError,
  createTokenStore,
  encryptionProblem,
  type Keychain,
  type TokenStore
} from '../../src/zonekeeper/main/auth/tokenStore'
import { UserError } from '../../src/zonekeeper/main/errors'
import { REQUIRED_PERMISSIONS } from '../../src/zonekeeper/shared/permissions'

const TOKEN = 'cf-secret-token-value-123'

function memoryStore(initial: string | null = null): TokenStore & { current: string | null; available: boolean; failSave: boolean } {
  const s = {
    current: initial,
    available: true,
    failSave: false,
    isAvailable: () => s.available,
    unavailableError: () => new EncryptionUnavailableError(),
    load: () => s.current,
    save: (t: string) => {
      if (s.failSave) throw new Error('EACCES /Users/someone/secret/path')
      s.current = t
    },
    clear: () => {
      s.current = null
    }
  }
  return s
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const verifyOk = (status = 'active') => json(200, { success: true, result: { id: 'x', status } })
const zonesOk = () => json(200, { success: true, result: [] })
const denied = (status: number) => json(status, { success: false, errors: [{ code: 9109, message: `echo ${TOKEN}` }] })

type Routes = { verify?: () => Response | Promise<Response>; zones?: () => Response | Promise<Response> }
function harness(routes: Routes, store = memoryStore()) {
  const calls: Array<{ url: string; auth: string | undefined }> = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.authorization })
    if (u === VERIFY_URL && routes.verify) return routes.verify()
    if (u === ZONES_PROBE_URL && routes.zones) return routes.zones()
    throw new Error(`unexpected request ${u}`)
  })
  const auth = createApiAuth({ fetch: fetchMock as unknown as typeof fetch, store })
  return { auth, store, calls, fetchMock }
}

afterEach(() => vi.restoreAllMocks())

describe('signInWithToken', () => {
  it('verifies, then stores the trimmed token', async () => {
    const h = harness({ verify: () => verifyOk() })
    await h.auth.signInWithToken(`  \t${TOKEN}\n `)
    expect(h.calls).toEqual([{ url: VERIFY_URL, auth: `Bearer ${TOKEN}` }])
    expect(h.store.current).toBe(TOKEN)
    expect(h.auth.isSignedIn()).toBe(true)
    expect(await h.auth.getAccessToken()).toBe(TOKEN)
  })

  it('uses the documented endpoints', () => {
    expect(VERIFY_URL).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify')
    expect(ZONES_PROBE_URL).toBe('https://api.cloudflare.com/client/v4/zones?per_page=1')
  })

  it('accepts an account-owned token: verify is refused but the zones check works', async () => {
    for (const status of [401, 403]) {
      const h = harness({ verify: () => denied(status), zones: () => zonesOk() })
      await h.auth.signInWithToken(TOKEN)
      expect(h.store.current).toBe(TOKEN)
      expect(h.calls.map((c) => c.url)).toEqual([VERIFY_URL, ZONES_PROBE_URL])
    }
  })

  it('a non-active verify result falls back to the zones check', async () => {
    const accepted = harness({ verify: () => verifyOk('expired'), zones: () => zonesOk() })
    await accepted.auth.signInWithToken(TOKEN)
    expect(accepted.store.current).toBe(TOKEN)
    const rejected = harness({ verify: () => verifyOk('disabled'), zones: () => denied(403) })
    await expect(rejected.auth.signInWithToken(TOKEN)).rejects.toBeInstanceOf(UserError)
    expect(rejected.store.current).toBeNull()
  })

  it('rejects and stores nothing when neither check confirms the token', async () => {
    for (const [v, z] of [
      [401, 401],
      [403, 403],
      [400, 400],
      [401, 403]
    ]) {
      const h = harness({ verify: () => denied(v), zones: () => denied(z) })
      const err = (await h.auth.signInWithToken(TOKEN).catch((e: unknown) => e)) as Error
      expect(err).toBeInstanceOf(UserError)
      expect(err.message).toMatch(/didn't accept/i)
      expect(err.message).not.toContain(TOKEN)
      expect(h.store.current).toBeNull()
      expect(h.auth.isSignedIn()).toBe(false)
    }
  })

  it('a 200 without success:true does not count', async () => {
    const h = harness({ verify: () => json(200, { result: { status: 'active' } }), zones: () => json(200, { success: false }) })
    await expect(h.auth.signInWithToken(TOKEN)).rejects.toThrow(/didn't accept/i)
    expect(h.store.current).toBeNull()
  })

  it('network errors and 5xx say Cloudflare could not be reached and store nothing', async () => {
    const cases: Routes[] = [
      {
        verify: () => {
          throw new Error(`offline ${TOKEN}`)
        }
      },
      { verify: () => json(500, {}) },
      { verify: () => json(503, {}) },
      { verify: () => denied(401), zones: () => json(502, {}) },
      {
        verify: () => denied(403),
        zones: () => {
          throw new Error('offline')
        }
      }
    ]
    for (const routes of cases) {
      const h = harness(routes)
      const err = (await h.auth.signInWithToken(TOKEN).catch((e: unknown) => e)) as Error
      expect(err).toBeInstanceOf(UserError)
      expect(err.message).toMatch(/couldn't reach Cloudflare/i)
      expect(err.message).not.toContain(TOKEN)
      expect(h.store.current).toBeNull()
    }
  })

  it('reports 429 as rate limiting, not as unreachable, and stores nothing', async () => {
    for (const routes of [{ verify: () => json(429, {}) }, { verify: () => denied(403), zones: () => json(429, {}) }] as Routes[]) {
      const h = harness(routes)
      const err = (await h.auth.signInWithToken(TOKEN).catch((e: unknown) => e)) as Error
      expect(err).toBeInstanceOf(UserError)
      expect(err.message).toMatch(/rate limiting/i)
      expect(err.message).not.toMatch(/couldn't reach/i)
      expect(h.store.current).toBeNull()
    }
  })

  it('a 401 for the old stored token does not cancel a sign-in with a new token', async () => {
    let release!: (r: Response) => void
    const gate = new Promise<Response>((r) => (release = r))
    const h = harness({ verify: () => gate }, memoryStore('old-token-value'))
    const pending = h.auth.signInWithToken(TOKEN)
    await new Promise((r) => setTimeout(r, 10))
    h.auth.handleRejected('old-token-value')
    expect(h.store.current).toBeNull()
    release(verifyOk())
    await pending
    expect(h.store.current).toBe(TOKEN)
    expect(h.auth.notice()).toBeNull()
  })

  it('refuses without any network call when secure storage is unavailable', async () => {
    const h = harness({ verify: () => verifyOk() })
    h.store.available = false
    await expect(h.auth.signInWithToken(TOKEN)).rejects.toBeInstanceOf(EncryptionUnavailableError)
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses on Linux basic_text and writes nothing', async () => {
    const msg = encryptionProblem('linux', true, 'basic_text')!
    const keychain: Keychain = { isAvailable: () => false, unavailableMessage: () => msg, encrypt: () => Buffer.alloc(0), decrypt: () => '' }
    const write = vi.fn()
    const store = createTokenStore(keychain, { read: () => null, write, remove: () => {} })
    const h = harness({ verify: () => verifyOk() }, store as never)
    await expect(h.auth.signInWithToken(TOKEN)).rejects.toThrow(/keyring/i)
    expect(h.fetchMock).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects empty and non-string input without a network call', async () => {
    for (const bad of ['', '   ', '\n', 42, null, undefined, { toString: () => TOKEN }, 'has space inside', 'line\nbreak', 'x'.repeat(5000)]) {
      const h = harness({ verify: () => verifyOk() })
      await expect(h.auth.signInWithToken(bad)).rejects.toBeInstanceOf(UserError)
      expect(h.fetchMock).not.toHaveBeenCalled()
      expect(h.store.current).toBeNull()
    }
  })

  it('a failed save hides the local path and the token', async () => {
    const store = memoryStore()
    store.failSave = true
    const h = harness({ verify: () => verifyOk() }, store)
    const err = (await h.auth.signInWithToken(TOKEN).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(UserError)
    expect(err.message).not.toContain('/Users/')
    expect(err.message).not.toContain(TOKEN)
    expect(h.auth.isSignedIn()).toBe(false)
  })

  it('signing out while verification is running saves nothing', async () => {
    let release!: (r: Response) => void
    const gate = new Promise<Response>((r) => (release = r))
    const h = harness({ verify: () => gate })
    const pending = h.auth.signInWithToken(TOKEN)
    const assertion = expect(pending).rejects.toBeInstanceOf(UserError)
    await new Promise((r) => setTimeout(r, 10))
    await h.auth.signOut()
    release(verifyOk())
    await assertion
    expect(h.store.current).toBeNull()
  })

  it('never logs the token', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const ok = harness({ verify: () => verifyOk() })
    await ok.auth.signInWithToken(TOKEN)
    const bad = harness({ verify: () => denied(401), zones: () => denied(401) })
    await bad.auth.signInWithToken(TOKEN).catch(() => {})
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(TOKEN)
  })

  it('clears a previous sign-out notice on success', async () => {
    const h = harness({ verify: () => verifyOk() }, memoryStore(TOKEN))
    h.auth.handleRejected(TOKEN)
    expect(h.auth.notice()).toMatch(/rejected/i)
    await h.auth.signInWithToken(TOKEN)
    expect(h.auth.notice()).toBeNull()
  })
})

describe('onChange', () => {
  it('fires on sign-in, sign-out and a 401 sign-out, and stops after unsubscribe', async () => {
    const h = harness({ verify: () => verifyOk() })
    const seen: Array<string | null> = []
    const off = h.auth.onChange(() => seen.push(h.auth.isSignedIn() ? 'in' : (h.auth.notice() ?? 'out')))
    await h.auth.signInWithToken(TOKEN)
    h.auth.handleRejected(TOKEN)
    await h.auth.signInWithToken(TOKEN)
    await h.auth.signOut()
    expect(seen).toEqual(['in', expect.stringMatching(/rejected/i), 'in', 'out'])
    off()
    await h.auth.signInWithToken(TOKEN)
    expect(seen).toHaveLength(4)
  })

  it('does not fire for a 401 about a token that is no longer stored, or a failed sign-in', async () => {
    const h = harness({ verify: () => denied(401), zones: () => denied(401) }, memoryStore(TOKEN))
    const listener = vi.fn()
    h.auth.onChange(listener)
    h.auth.handleRejected('some-older-token')
    await h.auth.signInWithToken('bad-token-value').catch(() => {})
    expect(listener).not.toHaveBeenCalled()
  })

  it('a throwing listener does not break sign-out', async () => {
    const h = harness({}, memoryStore(TOKEN))
    h.auth.onChange(() => {
      throw new Error('boom')
    })
    await h.auth.signOut()
    expect(h.store.current).toBeNull()
  })
})

describe('tokenStore', () => {
  const keychain: Keychain = { isAvailable: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }
  const mk = (blob: Buffer | null) => {
    let data = blob
    return createTokenStore(keychain, { read: () => data, write: (d) => (data = d), remove: () => (data = null) })
  }
  it('round-trips a token and clears it', () => {
    const s = mk(null)
    s.save(TOKEN)
    expect(s.load()).toBe(TOKEN)
    s.clear()
    expect(s.load()).toBeNull()
  })
  it('old-shape and corrupt blobs read as signed out', () => {
    expect(mk(Buffer.from(JSON.stringify({ accessToken: 'a', expiresAt: 1 }))).load()).toBeNull()
    expect(mk(Buffer.from('not json')).load()).toBeNull()
    expect(mk(Buffer.from(JSON.stringify({ token: '' }))).load()).toBeNull()
  })
})

describe('signOut and getAccessToken', () => {
  it('sign-out clears the stored token', async () => {
    const h = harness({}, memoryStore(TOKEN))
    expect(h.auth.isSignedIn()).toBe(true)
    await h.auth.signOut()
    expect(h.store.current).toBeNull()
    expect(h.auth.isSignedIn()).toBe(false)
    await expect(h.auth.getAccessToken()).rejects.toMatchObject({ name: 'NotSignedInError' })
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('throws NotSignedInError with nothing stored', async () => {
    const h = harness({})
    await expect(h.auth.getAccessToken()).rejects.toMatchObject({ name: 'NotSignedInError' })
  })
})

describe('withSignOutOn401', () => {
  function wrapped(status: number, store = memoryStore(TOKEN), usedToken = TOKEN) {
    const h = harness({}, store)
    const inner = vi.fn(async () => json(status, {}))
    const f = withSignOutOn401(inner as unknown as typeof fetch, h.auth)
    return { h, f, run: () => f('https://api.cloudflare.com/client/v4/zones', { headers: { authorization: `Bearer ${usedToken}` } }) }
  }

  it('a 401 for the stored token signs out with a clear message', async () => {
    const { h, run } = wrapped(401)
    const res = await run()
    expect(res.status).toBe(401)
    expect(h.store.current).toBeNull()
    expect(h.auth.isSignedIn()).toBe(false)
    expect(h.auth.notice()).toMatch(/Cloudflare rejected your API token/)
    expect(h.auth.notice()).not.toContain(TOKEN)
  })

  it('403 means missing permission and does not sign out', async () => {
    const { h, run } = wrapped(403)
    await run()
    expect(h.store.current).toBe(TOKEN)
    expect(h.auth.notice()).toBeNull()
  })

  it('network errors, 5xx and 429 do not sign out', async () => {
    for (const status of [500, 502, 429]) {
      const { h, run } = wrapped(status)
      await run()
      expect(h.store.current).toBe(TOKEN)
    }
    const h = harness({}, memoryStore(TOKEN))
    const f = withSignOutOn401(
      (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
      h.auth
    )
    await expect(f('https://x', { headers: { authorization: `Bearer ${TOKEN}` } })).rejects.toThrow('offline')
    expect(h.store.current).toBe(TOKEN)
  })

  it('a 401 for an older token does not sign out a newer sign-in', async () => {
    const { h, run } = wrapped(401, memoryStore('a-newer-token-value'), TOKEN)
    await run()
    expect(h.store.current).toBe('a-newer-token-value')
  })
})

describe('required permissions', () => {
  it('lists every needed permission once, with a scope', () => {
    const names = REQUIRED_PERMISSIONS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining([
        'Zone Read',
        'Zone WAF Edit',
        'Transform Rules Edit',
        'Single Redirect Edit',
        'Page Rules Edit',
        'Bulk URL Redirects Edit',
        'Account Filter Lists Edit',
        'Account Rulesets Edit',
        'DNS Write',
        'Zone Settings Edit',
        'SSL and Certificates Edit',
        'Cache Rules Edit',
        'Analytics Read',
        'Account Settings Read'
      ])
    )
    expect(names).not.toContain('Cache Settings Edit')
    expect(names).not.toContain('DNS Edit')
    expect(REQUIRED_PERMISSIONS.find((p) => p.name === 'Bulk URL Redirects Edit')?.scope).toBe('Account')
    expect(REQUIRED_PERMISSIONS.find((p) => p.name === 'Zone Read')?.scope).toBe('Zone')
  })
})
