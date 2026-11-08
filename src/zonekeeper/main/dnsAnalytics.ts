import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { AnalyticsCount, DnsAnalytics, IpcResult } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'

const HOUR_MS = 3_600_000
const input = z.strictObject({
  zoneIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(1000),
  hours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(72), z.literal(168)])
})

/** Separate queries, so one refusal doesn't hide the rest. */
const BREAKDOWNS = {
  hourly: { dims: 'datetimeHour', order: 'datetimeHour_ASC', limit: 500 },
  types: { dims: 'queryType', order: 'count_DESC', limit: 20 },
  codes: { dims: 'responseCode', order: 'count_DESC', limit: 20 },
  names: { dims: 'queryName', order: 'count_DESC', limit: 15 },
  cached: { dims: 'responseCached', order: 'count_DESC', limit: 5 },
  colos: { dims: 'coloName', order: 'count_DESC', limit: 10 },
  protocols: { dims: 'protocol', order: 'count_DESC', limit: 10 },
  ipVersions: { dims: 'ipVersion', order: 'count_DESC', limit: 5 }
} as const
type Key = keyof typeof BREAKDOWNS

const query = (k: Key): string => {
  const b = BREAKDOWNS[k]
  return `query($zoneTags: [string!], $since: Time, $until: Time) { viewer { zones(filter: { zoneTag_in: $zoneTags }) {
  rows: dnsAnalyticsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: ${b.limit}, orderBy: [${b.order}]) { count dimensions { ${b.dims} } }
} } }`
}

type Row = { count?: number; dimensions?: Record<string, string | number | boolean | undefined> }
type Viewer = { viewer?: { zones?: { rows?: Row[] }[] } }

export function createDnsAnalyticsHandler(deps: { client: Pick<CfClient, 'graphql'>; now?: () => Date }) {
  const now = deps.now ?? (() => new Date())
  return async (raw: unknown): Promise<IpcResult<DnsAnalytics>> => {
    const i = input.safeParse(raw)
    if (!i.success) return { ok: false, error: 'That request was not valid.' }
    const until = now()
    const range = { since: new Date(until.getTime() - i.data.hours * HOUR_MS).toISOString(), until: until.toISOString() }
    // 10 zones per query max
    const batches: string[][] = []
    for (let n = 0; n < i.data.zoneIds.length; n += 10) batches.push(i.data.zoneIds.slice(n, n + 10))
    const keys = Object.keys(BREAKDOWNS) as Key[]
    const settled = await Promise.allSettled(
      keys.map(async (k): Promise<Viewer> => {
        const parts = await Promise.all(batches.map((zoneTags) => deps.client.graphql<Viewer>(query(k), { zoneTags, ...range })))
        return { viewer: { zones: parts.flatMap((p) => p.viewer?.zones ?? []) } }
      })
    )
    const first401 = settled.find((s) => s.status === 'rejected' && s.reason instanceof CfApiError && s.reason.status === 401)
    if (first401) return { ok: false, error: 'Cloudflare rejected your API token.' }
    if (settled.every((s) => s.status === 'rejected')) return { ok: false, error: errorText((settled[0] as PromiseRejectedResult).reason) }

    const out: Record<Key, AnalyticsCount[]> = Object.fromEntries(keys.map((k) => [k, []])) as never
    const missing: string[] = []
    settled.forEach((s, n) => {
      const k = keys[n] as Key
      if (s.status === 'rejected') return void missing.push(`${k}: ${errorText(s.reason)}`)
      const totals = new Map<string, number>()
      for (const z of s.value.viewer?.zones ?? []) {
        for (const r of z.rows ?? []) {
          const v = r.dimensions?.[BREAKDOWNS[k].dims]
          const label = v === undefined || v === '' ? 'Unknown' : String(v)
          totals.set(label, (totals.get(label) ?? 0) + (r.count ?? 0))
        }
      }
      const rows = [...totals.entries()].map(([label, count]) => ({ label, count }))
      out[k] = k === 'hourly' ? rows.sort((a, b) => a.label.localeCompare(b.label)) : rows.sort((a, b) => b.count - a.count).slice(0, BREAKDOWNS[k].limit)
    })
    const total = (out.codes.length ? out.codes : out.types).reduce((a, r) => a + r.count, 0)
    return {
      ok: true,
      value: {
        hours: i.data.hours,
        total,
        hourly: out.hourly.map((h) => ({ hour: h.label, count: h.count })),
        types: out.types,
        codes: out.codes,
        names: out.names,
        cached: out.cached.map((c) => ({ label: c.label === 'true' ? 'Cached' : c.label === 'false' ? 'Not cached' : c.label, count: c.count })),
        colos: out.colos,
        protocols: out.protocols,
        ipVersions: out.ipVersions.map((c) => ({ label: /^\d+$/.test(c.label) ? `IPv${c.label}` : c.label, count: c.count })),
        missing
      }
    }
  }
}
