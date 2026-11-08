import { describe, expect, it, vi } from 'vitest'
import { createHandlers } from '../../src/zonekeeper/main/ipc'
import { createGuard, isTrustedEvent, isTrustedSender } from '../../src/app/main/ipcGuard'
import { CfApiError, type CfClient, type Zone } from '../../src/zonekeeper/main/cloudflare/client'
import type { Auth } from '../../src/zonekeeper/main/auth/apiToken'
import { UserError } from '../../src/zonekeeper/main/errors'

function setup(signIn: (raw: unknown) => Promise<void> = async () => {}) {
  let signedIn = true
  const auth: Auth = {
    signInWithToken: vi.fn(signIn),
    signOut: vi.fn(async () => {
      signedIn = false
    }),
    getAccessToken: vi.fn(async () => 'SECRET-TOKEN'),
    isSignedIn: vi.fn(() => signedIn),
    notice: vi.fn(() => null),
    handleRejected: vi.fn(),
    onChange: vi.fn(() => () => {})
  }
  const openTokenPage = vi.fn(async () => {})
  const listZones = vi.fn(async (): Promise<Zone[]> => [])
  const client = { listZones } as unknown as Pick<CfClient, 'listZones'>
  return { h: createHandlers({ auth, openTokenPage, client }), auth, openTokenPage, listZones }
}

describe('listZones handler', () => {
  it('returns only id, name, status and the plan name, even if the client returns more', async () => {
    const { h, listZones } = setup()
    const extra: Zone = {
      ...{
        id: 'z1',
        name: 'example.com',
        status: 'active',
        plan: { name: 'Free Website', id: 'plan-secret', price: 0 } as { name?: string },
        account: { id: 'acc1', name: 'Acct' },
        name_servers: ['a.ns.cloudflare.com'],
        token: 'SECRET-TOKEN',
        permissions: ['#zone:read']
      }
    }
    listZones.mockResolvedValue([extra])
    const r = await h.listZones()
    expect(r).toEqual({ ok: true, value: [{ id: 'z1', name: 'example.com', status: 'active', plan: 'Free Website' }] })
    expect(JSON.stringify(r)).not.toContain('SECRET-TOKEN')
    expect(JSON.stringify(r)).not.toContain('acc1')
  })

  it('uses null for a missing status or plan', async () => {
    const { h, listZones } = setup()
    listZones.mockResolvedValue([{ id: 'z2', name: 'b.com' }])
    expect(await h.listZones()).toEqual({ ok: true, value: [{ id: 'z2', name: 'b.com', status: null, plan: null }] })
  })

  it('maps a 403 to a Zone Read message', async () => {
    const { h, listZones } = setup()
    listZones.mockRejectedValue(new CfApiError(403, 'raw server text SECRET-TOKEN'))
    const r = await h.listZones()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('Zone Read')
      expect(r.error).not.toContain('SECRET-TOKEN')
    }
  })

  it('maps other failures to fixed text without echoing the server message', async () => {
    const { h, listZones } = setup()
    listZones.mockRejectedValue(new CfApiError(500, 'internal /Users/x SECRET-TOKEN'))
    const r = await h.listZones()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toMatch(/SECRET-TOKEN|\/Users/)
    listZones.mockRejectedValue(new Error('boom SECRET-TOKEN'))
    expect(await h.listZones()).toEqual({ ok: false, error: 'boom [redacted]' })
    listZones.mockRejectedValue(new UserError('You are signed out.'))
    expect(await h.listZones()).toEqual({ ok: false, error: 'You are signed out.' })
  })
})

describe('guard', () => {
  it('runs the handler for a trusted sender and throws without running it for an untrusted one', () => {
    const guard = createGuard()
    const fn = vi.fn((x: number) => x + 1)
    const main = { url: 'file:///app/index.html' }
    const trusted = { senderFrame: main, sender: { mainFrame: main } }
    expect(guard(fn)(trusted, 1)).toBe(2)
    const evil = { url: 'https://evil.example/' }
    expect(() => guard(fn)({ senderFrame: evil, sender: { mainFrame: evil } }, 1)).toThrow('Untrusted sender')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('ipc handlers', () => {
  it('state exposes only the signed-in flag and notice', async () => {
    const { h } = setup()
    const s = await h.authState()
    expect(s).toEqual({ signedIn: true, notice: null })
    expect(JSON.stringify(s)).not.toContain('SECRET-TOKEN')
  })

  it('a successful sign-in returns state, never the token', async () => {
    const { h, auth } = setup()
    const r = await h.signInWithToken('  SECRET-TOKEN  ')
    expect(r).toEqual({ ok: true, value: { signedIn: true, notice: null } })
    expect(JSON.stringify(r)).not.toContain('SECRET-TOKEN')
    expect(auth.signInWithToken).toHaveBeenCalledWith('  SECRET-TOKEN  ')
  })

  it('user-facing errors come back as messages, not exceptions', async () => {
    const { h } = setup(async () => {
      throw new UserError('Secure storage is not available')
    })
    expect(await h.signInWithToken('t')).toEqual({ ok: false, error: 'Secure storage is not available' })
  })

  it('other errors are shown as they are, but never with the token', async () => {
    const { h } = setup(async () => {
      throw new Error('EACCES: permission denied PASTED-TOKEN and SECRET-TOKEN')
    })
    expect(await h.signInWithToken('  PASTED-TOKEN  ')).toEqual({ ok: false, error: 'EACCES: permission denied [redacted] and [redacted]' })
  })

  it('sign-out calls through and returns the new state', async () => {
    const { h, auth } = setup()
    expect(await h.signOut()).toEqual({ ok: true, value: { signedIn: false, notice: null } })
    expect(auth.signOut).toHaveBeenCalled()
  })

  it('opens the token page via the injected opener', async () => {
    const { h, openTokenPage } = setup()
    await h.openTokenPage()
    expect(openTokenPage).toHaveBeenCalled()
  })
})

describe('isTrustedEvent', () => {
  it('requires the main frame as well as a trusted URL', () => {
    const main = { url: 'file:///app/index.html' }
    expect(isTrustedEvent({ senderFrame: main, sender: { mainFrame: main } })).toBe(true)
    // A sub-frame on a trusted URL is refused.
    expect(isTrustedEvent({ senderFrame: { url: main.url }, sender: { mainFrame: main } })).toBe(false)
    expect(isTrustedEvent({ senderFrame: null, sender: { mainFrame: main } })).toBe(false)
    const evil = { url: 'https://evil.example/' }
    expect(isTrustedEvent({ senderFrame: evil, sender: { mainFrame: evil } })).toBe(false)
  })
})

describe('isTrustedSender', () => {
  it('allows file: in production and only the dev origin in dev', () => {
    expect(isTrustedSender('file:///app/index.html')).toBe(true)
    expect(isTrustedSender('https://evil.example/')).toBe(false)
    expect(isTrustedSender('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isTrustedSender('file:///app/index.html', 'http://localhost:5173')).toBe(false)
    expect(isTrustedSender('')).toBe(false)
  })
})
