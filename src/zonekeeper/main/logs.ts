import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult, LogRow, LogsView } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'

const input = z.strictObject({ zoneIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(1000), hours: z.union([z.literal(1), z.literal(6), z.literal(24)]) })

const SAMPLED_FIELDS = [
  'datetime', 'clientIP', 'clientRequestHTTPMethodName', 'clientRequestHTTPHost', 'clientRequestPath', 'clientRequestQuery', 'edgeResponseStatus',
  'clientCountryName', 'userAgent', 'clientRequestReferer', 'cacheStatus', 'edgeResponseBytes', 'clientAsn', 'clientASNDescription',
  'clientRequestHTTPProtocol', 'rayName', 'edgeTimeToFirstByteMs', 'edgeResponseContentTypeName'
]
const REQUIRED = new Set(['datetime', 'clientRequestPath', 'edgeResponseStatus'])
/** Refused fields, skipped for the session. */
const unknownFields = new Set<string>()
const deniedFields = new Map<string, Set<string>>()

const sampledQuery = (zoneTag: string): string => `query($zoneTag: string, $since: Time, $until: Time) { viewer { zones(filter: { zoneTag: $zoneTag }) {
  httpRequestsAdaptive(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 200, orderBy: [datetime_DESC]) {
    ${SAMPLED_FIELDS.filter((f) => !unknownFields.has(f) && !deniedFields.get(zoneTag)?.has(f)).join(' ')}
  }
} } }`

function refusedField(text: string): { field: string; denied: boolean } | null {
  const unknown = /unknown field "([A-Za-z]+)"/.exec(text)?.[1]
  if (unknown) return { field: unknown, denied: false }
  // Named in lower case
  const denied = /does not have access to the field '([A-Za-z]+)'/.exec(text)?.[1]?.toLowerCase()
  const field = denied ? SAMPLED_FIELDS.find((f) => f.toLowerCase() === denied) : undefined
  return field ? { field, denied: true } : null
}

type Sampled = { viewer?: { zones?: { httpRequestsAdaptive?: Array<Record<string, string | number | undefined>> }[] } }

/** Fallback without Log Explorer. */
async function sampledLogs(client: Pick<CfClient, 'graphql'>, zoneTag: string, since: Date, until: Date): Promise<LogRow[]> {
  let r: Sampled | undefined
  for (let attempt = 0; r === undefined; attempt++) {
    try {
      r = await client.graphql<Sampled>(sampledQuery(zoneTag), { zoneTag, since: since.toISOString(), until: until.toISOString() })
    } catch (e) {
      const refused = refusedField(errorText(e))
      if (!refused || REQUIRED.has(refused.field) || attempt >= SAMPLED_FIELDS.length) throw e
      if (refused.denied) deniedFields.set(zoneTag, new Set([...(deniedFields.get(zoneTag) ?? []), refused.field]))
      else unknownFields.add(refused.field)
    }
  }
  const v = (x: string | number | undefined): string => (x === undefined ? '' : String(x))
  return (r.viewer?.zones?.[0]?.httpRequestsAdaptive ?? []).map((x) => ({
    time: v(x.datetime),
    ip: v(x.clientIP),
    method: v(x.clientRequestHTTPMethodName),
    host: v(x.clientRequestHTTPHost),
    uri: `${v(x.clientRequestPath)}${v(x.clientRequestQuery)}`,
    status: v(x.edgeResponseStatus),
    country: v(x.clientCountryName),
    userAgent: v(x.userAgent),
    referer: v(x.clientRequestReferer),
    cache: v(x.cacheStatus),
    bytes: v(x.edgeResponseBytes),
    asn: [x.clientAsn ? `AS${v(x.clientAsn)}` : '', v(x.clientASNDescription)].filter(Boolean).join(' '),
    protocol: v(x.clientRequestHTTPProtocol),
    rayId: v(x.rayName),
    ttfbMs: v(x.edgeTimeToFirstByteMs),
    contentType: v(x.edgeResponseContentTypeName)
  }))
}

export function createLogsHandler(deps: { client: Pick<CfClient, 'get' | 'graphql'>; now?: () => Date }) {
  const now = deps.now ?? (() => new Date())
  const one = createZoneLogs(deps.client)
  return async (raw: unknown): Promise<IpcResult<LogsView>> => {
    const i = input.safeParse(raw)
    if (!i.success) return { ok: false, error: 'That request was not valid.' }
    const until = now()
    const since = new Date(until.getTime() - i.data.hours * 3_600_000)
    const results: Array<{ zoneId: string; r: IpcResult<LogRow[]> }> = []
    // A few at a time, for the rate limit
    for (let n = 0; n < i.data.zoneIds.length; n += 4) {
      const batch = i.data.zoneIds.slice(n, n + 4)
      results.push(...(await Promise.all(batch.map(async (zoneId) => ({ zoneId, r: await one(zoneId, since, until) })))))
    }
    const failed = results.flatMap((x) => (x.r.ok ? [] : [{ zoneId: x.zoneId, error: x.r.error }]))
    if (failed.length === results.length) return { ok: false, error: failed[0]?.error ?? 'No logs could be read.' }
    const rows = results.flatMap((x) => (x.r.ok ? x.r.value : [])).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 500)
    return { ok: true, value: { rows, failed } }
  }
}

function createZoneLogs(client: Pick<CfClient, 'get' | 'graphql'>) {
  const deps = { client }
  return async (zoneId: string, since: Date, until: Date): Promise<IpcResult<LogRow[]>> => {
    const i = { data: { zoneId } }
    const query = `SELECT EdgeStartTimestamp, ClientIP, ClientRequestMethod, ClientRequestHost, ClientRequestURI, EdgeResponseStatus, ClientCountry, ClientRequestUserAgent, ClientRequestReferer, CacheCacheStatus, EdgeResponseBytes, ClientASN, ClientRequestProtocol, RayID, EdgeTimeToFirstByteMs, EdgeResponseContentType FROM http_requests WHERE EdgeStartTimestamp >= '${since.toISOString()}' AND EdgeStartTimestamp <= '${until.toISOString()}' ORDER BY EdgeStartTimestamp DESC LIMIT 200`
    try {
      const rows = await deps.client.get<Array<Record<string, unknown>>>(`/zones/${i.data.zoneId}/logs/explorer/query/sql?${new URLSearchParams({ query })}`)
      const s = (r: Record<string, unknown>, k: string): string => String(r[k] ?? '')
      return {
        ok: true,
        value: rows.map((r) => ({
          time: s(r, 'edgestarttimestamp'),
          ip: s(r, 'clientip'),
          method: s(r, 'clientrequestmethod'),
          host: s(r, 'clientrequesthost'),
          uri: s(r, 'clientrequesturi'),
          status: s(r, 'edgeresponsestatus'),
          country: s(r, 'clientcountry'),
          userAgent: s(r, 'clientrequestuseragent'),
          referer: s(r, 'clientrequestreferer'),
          cache: s(r, 'cachecachestatus'),
          bytes: s(r, 'edgeresponsebytes'),
          asn: s(r, 'clientasn') ? `AS${s(r, 'clientasn')}` : '',
          protocol: s(r, 'clientrequestprotocol'),
          rayId: s(r, 'rayid'),
          ttfbMs: s(r, 'edgetimetofirstbytems'),
          contentType: s(r, 'edgeresponsecontenttype')
        }))
      }
    } catch (e) {
      if (e instanceof CfApiError && (e.status === 403 || e.status === 404)) {
        try {
          return { ok: true, value: await sampledLogs(deps.client, i.data.zoneId, since, until) }
        } catch (fallback) {
          if (/does not have access to the path/i.test(errorText(fallback))) {
            return { ok: false, error: "This zone's plan doesn't include request logs through the API. Logs need Log Explorer, or a Pro plan or higher for sampled logs." }
          }
          return { ok: false, error: `Logs aren't available for this zone: ${errorText(fallback)}` }
        }
      }
      if (e instanceof CfApiError && e.status === 401) return { ok: false, error: 'Cloudflare rejected your API token.' }
      return { ok: false, error: errorText(e) }
    }
  }
}
