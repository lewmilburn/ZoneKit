import type { AuthState, IpcResult, ZoneSummary } from '../shared/ipc'
import { errorText } from '../shared/errorText'
import type { Auth } from './auth/apiToken'
import { CfApiError, type CfClient } from './cloudflare/client'
import { UserError } from './errors'
import { redact } from './redact'

export interface IpcDeps {
  auth: Auth
  client: Pick<CfClient, 'listZones'>
  openTokenPage: () => Promise<void>
}

function describe(e: unknown): string {
  if (e instanceof UserError && e.message) return e.message
  return errorText(e)
}

function describeZonesError(e: unknown): string {
  if (e instanceof CfApiError) {
    if (e.status === 403) {
      return 'Your token needs the Zone Read permission.'
    }
    if (e.status === 401) return 'Cloudflare rejected your API token, paste a new one.'
    if (e.status === 429) return 'Cloudflare is rate limiting requests, try again in a minute.'
    if (e.status === 0) return "Couldn't reach Cloudflare, check your connection."
    if (e.status >= 500) return 'Cloudflare had a problem answering, try again shortly.'
    return 'Cloudflare could not list your zones.'
  }
  return describe(e)
}

/** Arguments are untrusted. */
export function createHandlers(deps: IpcDeps) {
  async function state(): Promise<AuthState> {
    return { signedIn: deps.auth.isSignedIn(), notice: deps.auth.notice() }
  }
  // Real error text is shown, so the token is taken out of it first
  async function safe(text: string, extra?: unknown): Promise<string> {
    const current = await deps.auth.getAccessToken().catch(() => null)
    return redact(text, [current, typeof extra === 'string' ? extra.trim() : null, typeof extra === 'string' ? extra : null])
  }
  async function wrap(fn: () => Promise<void>, token?: unknown): Promise<IpcResult<AuthState>> {
    try {
      await fn()
      return { ok: true, value: await state() }
    } catch (e) {
      return { ok: false, error: await safe(describe(e), token) }
    }
  }
  return {
    authState: state,
    signInWithToken: (raw: unknown) => wrap(() => deps.auth.signInWithToken(raw), raw),
    signOut: () => wrap(() => deps.auth.signOut()),
    openTokenPage: () => deps.openTokenPage(),
    async listZones(): Promise<IpcResult<ZoneSummary[]>> {
      try {
        const zones = await deps.client.listZones()
        // Field by field, so nothing extra leaks
        return {
          ok: true,
          value: zones.map((z) => ({
            id: String(z.id),
            name: String(z.name),
            status: typeof z.status === 'string' ? z.status : null,
            plan: typeof z.plan?.name === 'string' ? z.plan.name : null
          }))
        }
      } catch (e) {
        return { ok: false, error: await safe(describeZonesError(e)) }
      }
    }
  }
}
