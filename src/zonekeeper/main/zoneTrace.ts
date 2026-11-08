import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult, TraceResult, TraceStep } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'
import { UserError } from './errors'

const input = z.strictObject({
  url: z.string().min(1).max(2000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional()
})

interface RawStep {
  action?: unknown
  description?: unknown
  expression?: unknown
  kind?: unknown
  matched?: unknown
  name?: unknown
  step_name?: unknown
  type?: unknown
  trace?: unknown
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Flattens to rules with their phase. */
export function flattenTrace(steps: unknown, phase = ''): TraceStep[] {
  if (!Array.isArray(steps)) return []
  return (steps as RawStep[]).flatMap((s) => {
    const here = text(s.name) || text(s.step_name) || phase
    const nested = flattenTrace(s.trace, here)
    if (nested.length > 0 || text(s.expression) === '') return nested
    return [{ phase, description: text(s.description), expression: text(s.expression), action: text(s.action), matched: s.matched === true }]
  })
}

/** Never reaches the origin. */
export function createZoneTraceHandler(deps: { client: Pick<CfClient, 'send' | 'listZones'> }) {
  return async (raw: unknown): Promise<IpcResult<TraceResult>> => {
    const i = input.safeParse(raw)
    if (!i.success) return { ok: false, error: 'Check the URL, method and country.' }
    try {
      let url: URL
      try {
        url = new URL(i.data.url)
      } catch {
        throw new UserError('Enter a full URL, such as https://example.com/path.')
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError('The URL must start with https:// or http://.')
      const host = url.hostname.toLowerCase()
      // Most specific zone wins
      const zone = (await deps.client.listZones())
        .filter((z) => host === z.name.toLowerCase() || host.endsWith(`.${z.name.toLowerCase()}`))
        .sort((a, b) => b.name.length - a.name.length)[0]
      if (!zone) throw new UserError(`${host} isn't on any zone this token can see.`)
      const account = zone.account?.id
      if (!account) throw new UserError(`The account for ${zone.name} couldn't be found.`)
      const r = await deps.client.send<{ status_code?: number; trace?: unknown }>('POST', `/accounts/${account}/request-tracer/trace`, {
        url: url.toString(),
        method: i.data.method,
        skip_response: true,
        ...(i.data.country ? { context: { geoloc: { iso_code: i.data.country.toUpperCase() } } } : {})
      })
      return { ok: true, value: { zoneName: zone.name, ...(r.status_code === undefined ? {} : { statusCode: r.status_code }), steps: flattenTrace(r.trace) } }
    } catch (e) {
      if (e instanceof CfApiError && e.status === 403) return { ok: false, error: 'Your token needs the Account permission "Allow Request Tracer Read" to test rules.' }
      return { ok: false, error: errorText(e) }
    }
  }
}
