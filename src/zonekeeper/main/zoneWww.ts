import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult, WwwDirection } from '../shared/ipc'
import { CfApiError, type CfClient, type Zone } from './cloudflare/client'
import { UserError } from './errors'

const PHASE = 'http_request_dynamic_redirect'
const REFS: Record<Exclude<WwwDirection, 'off'>, string> = { toApex: 'zonekeeper-www-to-apex', toWww: 'zonekeeper-www-to-www' }
const OWN_REFS = Object.values(REFS)
/** Cloudflare's placeholder for a rules-only hostname. */
const PLACEHOLDER = { type: 'AAAA', content: '100::' }

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const saveInput = z.strictObject({ zoneId: id, direction: z.enum(['off', 'toApex', 'toWww']), confirmed: z.literal(true) })

interface RawRule { id: string; ref?: string }
interface RawRuleset { id: string; rules?: RawRule[] }
interface RawDns { id: string; type: string; name: string; content?: string; proxied?: boolean }

function describe(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof CfApiError && e.status === 403) return 'Your token needs the Single Redirect and DNS permissions for this zone.'
  if (e instanceof CfApiError && e.status === 401) return 'Cloudflare rejected your API token.'
  return errorText(e)
}

function ruleFor(zone: Zone, direction: Exclude<WwwDirection, 'off'>): Record<string, unknown> {
  const toApex = direction === 'toApex'
  const from = toApex ? `www.${zone.name}` : zone.name
  const to = toApex ? zone.name : `www.${zone.name}`
  return {
    ref: REFS[direction],
    description: `Redirect ${from} to ${to}`,
    expression: `http.host eq "${from}"`,
    action: 'redirect',
    action_parameters: {
      from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: `concat("https://${to}", http.request.uri.path)` } }
    },
    enabled: true
  }
}

const sourceOf = (zone: Zone, direction: Exclude<WwwDirection, 'off'>): string => (direction === 'toApex' ? `www.${zone.name}` : zone.name)

export function createZoneWwwHandlers(deps: { client: Pick<CfClient, 'get' | 'getPage' | 'send' | 'listZones'> }) {
  async function ruleset(zoneId: string): Promise<RawRuleset | null> {
    try {
      return await deps.client.get<RawRuleset>(`/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`)
    } catch (e) {
      if (e instanceof CfApiError && e.status === 404) return null
      throw e
    }
  }
  const directionOf = (rs: RawRuleset | null): WwwDirection => {
    const ref = rs?.rules?.find((r) => r.ref && OWN_REFS.includes(r.ref))?.ref
    return ref === REFS.toApex ? 'toApex' : ref === REFS.toWww ? 'toWww' : 'off'
  }
  async function records(zone: Zone, host: string): Promise<RawDns[]> {
    const qs = new URLSearchParams({ per_page: '1000' })
    const { result } = await deps.client.getPage<RawDns[]>(`/zones/${zone.id}/dns_records?${qs}`)
    return result.filter((r) => r.name === host && ['A', 'AAAA', 'CNAME'].includes(r.type))
  }

  return {
    async get(raw: unknown): Promise<IpcResult<WwwDirection>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      try {
        return { ok: true, value: directionOf(await ruleset(zoneId.data)) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async save(raw: unknown): Promise<IpcResult<WwwDirection>> {
      const i = saveInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'That request was not valid.' }
      const { zoneId, direction } = i.data
      try {
        const zone = (await deps.client.listZones()).find((z) => z.id === zoneId)
        if (!zone) throw new UserError('That zone was not found for this token.')
        const rs = await ruleset(zoneId)
        const before = directionOf(rs)
        const existing = rs?.rules?.find((r) => r.ref && OWN_REFS.includes(r.ref))
        const path = `/zones/${zoneId}/rulesets`

        if (direction === 'off') {
          if (rs && existing) await deps.client.send('DELETE', `${path}/${rs.id}/rules/${existing.id}`)
        } else {
          const rule = ruleFor(zone, direction)
          if (rs && existing) await deps.client.send('PATCH', `${path}/${rs.id}/rules/${existing.id}`, rule)
          else if (rs) await deps.client.send('POST', `${path}/${rs.id}/rules`, rule)
          else await deps.client.send('POST', path, { name: `Zonekeeper ${PHASE}`, kind: 'zone', phase: PHASE, rules: [rule] })

          // The source must be proxied
          const source = sourceOf(zone, direction)
          const found = await records(zone, source)
          const dns = `/zones/${zoneId}/dns_records`
          if (found.length === 0) await deps.client.send('POST', dns, { ...PLACEHOLDER, name: source, proxied: true, ttl: 1 })
          else if (!found.some((r) => r.proxied)) for (const r of found) await deps.client.send('PATCH', `${dns}/${encodeURIComponent(r.id)}`, { proxied: true })
        }

        // Only our placeholder
        if (before !== 'off' && before !== direction) {
          for (const r of await records(zone, sourceOf(zone, before))) {
            if (r.type === PLACEHOLDER.type && r.content === PLACEHOLDER.content) await deps.client.send('DELETE', `/zones/${zoneId}/dns_records/${encodeURIComponent(r.id)}`)
          }
        }
        return { ok: true, value: direction }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
