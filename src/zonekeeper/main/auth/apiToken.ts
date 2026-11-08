import { API_BASE } from '../cloudflare/client'
import { UserError } from '../errors'
import { redact } from '../redact'
import type { TokenStore } from './tokenStore'

export const VERIFY_URL = `${API_BASE}/user/tokens/verify`
// Fallback check for account-owned tokens, which /user/tokens/verify rejects.
export const ZONES_PROBE_URL = `${API_BASE}/zones?per_page=1`

const MAX_TOKEN_LENGTH = 1024
// Visible ASCII only.
const HEADER_SAFE = /^[\x21-\x7e]+$/

export class NotSignedInError extends UserError {
  constructor(message = 'You are signed out, paste a Cloudflare API token.') {
    super(message)
    this.name = 'NotSignedInError'
  }
}

const NOT_ACCEPTED = "Cloudflare didn't accept that token, it needs at least Zone Read permission."
const UNREACHABLE = "Couldn't reach Cloudflare, check your connection."
const RATE_LIMITED = 'Cloudflare is rate limiting requests, try again in a minute.'
const REJECTED_NOTICE = 'Cloudflare rejected your API token, paste a new one.'

export interface Auth {
  /** Never returns or echoes the token. */
  signInWithToken(raw: unknown): Promise<void>
  signOut(): Promise<void>
  /** Main process only. */
  getAccessToken(): Promise<string>
  isSignedIn(): boolean
  notice(): string | null
  /** On a 401, signs out only if `token` is still stored. */
  handleRejected(token: string): void
  /** Returns an unsubscribe function. */
  onChange(listener: () => void): () => void
}

export interface ApiAuthDeps {
  fetch: typeof fetch
  store: TokenStore
}

type Check = 'ok' | 'denied' | 'unreachable' | 'rate-limited'

export function createApiAuth(deps: ApiAuthDeps): Auth {
  let notice: string | null = null
  const listeners = new Set<() => void>()
  function changed(): void {
    for (const l of [...listeners]) {
      try {
        l()
      } catch {
        /* a failing listener must not break sign-in or sign-out */
      }
    }
  }
  // Stops stale verifications from saving
  let generation = 0

  async function get(url: string, token: string): Promise<Response | null> {
    try {
      return await deps.fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } })
    } catch {
      return null
    }
  }

  async function body(res: Response): Promise<{ success?: unknown; result?: unknown } | null> {
    try {
      const parsed: unknown = await res.json()
      return parsed && typeof parsed === 'object' ? (parsed as { success?: unknown; result?: unknown }) : null
    } catch {
      return null
    }
  }

  async function verify(token: string): Promise<Check> {
    const res = await get(VERIFY_URL, token)
    if (!res) return 'unreachable'
    if (res.status === 429) return 'rate-limited'
    if (res.status >= 500) return 'unreachable'
    if (res.status === 200) {
      const b = await body(res)
      const status = (b?.result as { status?: unknown } | undefined)?.status
      if (b?.success === true && status === 'active') return 'ok'
    }
    // Account-owned tokens fail here, so try the zones check
    return 'denied'
  }

  async function zonesProbe(token: string): Promise<Check> {
    const res = await get(ZONES_PROBE_URL, token)
    if (!res) return 'unreachable'
    if (res.status === 429) return 'rate-limited'
    if (res.status >= 500) return 'unreachable'
    if (res.status === 200) {
      const b = await body(res)
      if (b?.success === true) return 'ok'
    }
    return 'denied'
  }

  return {
    async signInWithToken(raw) {
      if (typeof raw !== 'string') throw new UserError('Paste your Cloudflare API token.')
      const token = raw.trim()
      if (!token) throw new UserError('Paste your Cloudflare API token.')
      if (token.length > MAX_TOKEN_LENGTH || !HEADER_SAFE.test(token)) throw new UserError(NOT_ACCEPTED)
      // Before sending, so a token we can't keep is never sent
      if (!deps.store.isAvailable()) throw deps.store.unavailableError()

      const startGen = generation
      let result = await verify(token)
      if (result === 'denied') result = await zonesProbe(token)
      if (result === 'rate-limited') throw new UserError(RATE_LIMITED)
      if (result === 'unreachable') throw new UserError(UNREACHABLE)
      if (result === 'denied') throw new UserError(NOT_ACCEPTED)
      if (startGen !== generation) throw new UserError('Sign-in was cancelled.')

      try {
        deps.store.save(token)
      } catch (e) {
        if (e instanceof UserError) throw e
        throw new UserError(redact('Could not save your token to secure storage.', [token]))
      }
      generation++
      notice = null
      changed()
    },

    async signOut() {
      generation++
      notice = null
      deps.store.clear()
      changed()
    },

    async getAccessToken() {
      const t = deps.store.load()
      if (!t) throw new NotSignedInError(notice ?? undefined)
      return t
    },

    isSignedIn: () => deps.store.load() !== null,

    notice: () => notice,

    handleRejected(token) {
      if (deps.store.load() !== token) return
      // Generation unchanged, so a sign-in in progress still finishes
      deps.store.clear()
      notice = REJECTED_NOTICE
      changed()
    },

    onChange(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}

function bearerOf(init?: RequestInit): string | null {
  const h = init?.headers
  if (!h) return null
  let value: string | null | undefined
  if (h instanceof Headers) value = h.get('authorization')
  else if (Array.isArray(h)) value = h.find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  else value = Object.entries(h).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  const m = /^Bearer (.+)$/.exec(value ?? '')
  return m ? m[1] : null
}

/** Only a 401 signs out, a 403 is just a missing permission. */
export function withSignOutOn401(inner: typeof fetch, auth: Pick<Auth, 'handleRejected'>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await inner(input, init)
    if (res.status === 401) {
      const token = bearerOf(init)
      if (token) auth.handleRejected(token)
    }
    return res
  }) as typeof fetch
}
