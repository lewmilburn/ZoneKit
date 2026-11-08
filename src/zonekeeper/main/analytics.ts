import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { AnalyticsCount, AnalyticsOverviewRow, AnalyticsSecurityEvent, IpcResult, ZoneAnalytics } from '../shared/ipc'
import { ANALYTICS_RANGES, ANALYTICS_OVERVIEW_HOURS } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'

export interface AnalyticsDeps {
  client: Pick<CfClient, 'graphql' | 'listZones'>
  now?: () => Date
}

/** Cloudflare's limit. */
export const ZONES_PER_QUERY = 10
const HOUR_MS = 3_600_000

const zoneInput = z.strictObject({
  zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  hours: z.number().refine((h) => (ANALYTICS_RANGES as readonly number[]).includes(h))
})

function describe(e: unknown): string {
  if (e instanceof CfApiError) {
    if (e.status === 401) return 'Cloudflare rejected your API token.'
    if (e.status === 403) return 'Your token needs the Analytics Read permission.'
    if (e.status === 429) return 'Cloudflare is rate limiting requests, try again in a few minutes.'
    if (e.status === 0) return "Couldn't reach Cloudflare, check your connection."
  }
  return errorText(e)
}

const SETTINGS = `query($zoneTag: string) { viewer { zones(filter: { zoneTag: $zoneTag }) { settings {
  httpRequestsAdaptiveGroups { maxDuration }
  firewallEventsAdaptive { maxDuration }
} } } }`

const TRAFFIC = `query($zoneTag: string, $since: Time, $until: Time) { viewer { zones(filter: { zoneTag: $zoneTag }) {
  totals: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 1) { count sum { edgeResponseBytes visits } }
  hourly: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 200, orderBy: [datetimeHour_ASC]) { count dimensions { datetimeHour } }
  statuses: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 100, orderBy: [count_DESC]) { count dimensions { edgeResponseStatus } }
  paths: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 10, orderBy: [count_DESC]) { count dimensions { clientRequestPath } }
  countries: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 10, orderBy: [count_DESC]) { count dimensions { clientCountryName } }
} } }`

const EVENTS = `query($zoneTag: string, $since: Time, $until: Time) { viewer { zones(filter: { zoneTag: $zoneTag }) {
  firewallEventsAdaptive(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 50, orderBy: [datetime_DESC]) {
    action source datetime clientIP clientCountryName clientRequestPath
  }
} } }`

const OVERVIEW = `query($zoneTags: [string!], $since: Time, $until: Time) { viewer { zones(filter: { zoneTag_in: $zoneTags }) {
  zoneTag
  totals: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 1) { count sum { edgeResponseBytes } }
} } }`

interface Totals { count?: number; sum?: { edgeResponseBytes?: number; visits?: number } }
type Viewer<T> = { viewer?: { zones?: T[] } }
type Group<K extends string> = { count?: number; dimensions?: Partial<Record<K, string | number>> }

interface TrafficZone {
  totals?: Totals[]
  hourly?: Group<'datetimeHour'>[]
  statuses?: Group<'edgeResponseStatus'>[]
  paths?: Group<'clientRequestPath'>[]
  countries?: Group<'clientCountryName'>[]
}

const inZones = (q: string): string => q.replace('$zoneTag: string', '$zoneTags: [string!]').replace('zoneTag: $zoneTag', 'zoneTag_in: $zoneTags')
const GLOBAL_TRAFFIC = inZones(TRAFFIC)
const GLOBAL_EVENTS = inZones(EVENTS)

const toEvent = (x: Record<string, string | undefined>): AnalyticsSecurityEvent => ({
  datetime: x.datetime ?? '',
  action: x.action ?? '',
  source: x.source ?? '',
  clientIP: x.clientIP ?? '',
  country: x.clientCountryName ?? '',
  path: x.clientRequestPath ?? ''
})

function counts<K extends string>(rows: Group<K>[] | undefined, key: K): AnalyticsCount[] {
  return (rows ?? []).map((r) => ({ label: String(r.dimensions?.[key] ?? 'Unknown') || 'Unknown', count: r.count ?? 0 }))
}

/** Separate queries, so one refusal doesn't hide the rest. */
const EXTRAS = {
  cache: 'cacheStatus',
  contentTypes: 'edgeResponseContentTypeName',
  protocols: 'clientRequestHTTPProtocol',
  devices: 'clientDeviceType',
  browsers: 'userAgentBrowser',
  os: 'userAgentOS',
  methods: 'clientRequestHTTPMethodName',
  hosts: 'clientRequestHTTPHost',
  referers: 'clientRefererHost'
} as const
type ExtraKey = keyof typeof EXTRAS

const extraQuery = (dim: string): string => `query($zoneTags: [string!], $since: Time, $until: Time) { viewer { zones(filter: { zoneTag_in: $zoneTags }) {
  rows: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 15, orderBy: [count_DESC]) { count dimensions { ${dim} } }
} } }`
const BANDWIDTH = `query($zoneTags: [string!], $since: Time, $until: Time) { viewer { zones(filter: { zoneTag_in: $zoneTags }) {
  rows: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 500, orderBy: [datetimeHour_ASC]) { sum { edgeResponseBytes } dimensions { datetimeHour } }
} } }`

async function extras(client: AnalyticsDeps['client'], zoneIds: string[], range: { since: string; until: string }): Promise<NonNullable<ZoneAnalytics['extra']>> {
  const batches: string[][] = []
  for (let n = 0; n < zoneIds.length; n += ZONES_PER_QUERY) batches.push(zoneIds.slice(n, n + ZONES_PER_QUERY))
  type Rows = Viewer<{ rows?: Array<{ count?: number; sum?: { edgeResponseBytes?: number }; dimensions?: Record<string, string | number | undefined> }> }>
  const run = async (q: string) => (await Promise.all(batches.map((zoneTags) => client.graphql<Rows>(q, { zoneTags, ...range })))).flatMap((r) => r.viewer?.zones ?? []).flatMap((z) => z.rows ?? [])
  const keys = Object.keys(EXTRAS) as ExtraKey[]
  const [bw, ...settled] = await Promise.allSettled([run(BANDWIDTH), ...keys.map((k) => run(extraQuery(EXTRAS[k])))])
  const missing: string[] = []
  const breakdowns = {} as Record<ExtraKey, AnalyticsCount[]>
  settled.forEach((s, n) => {
    const k = keys[n] as ExtraKey
    if (s.status === 'rejected') {
      breakdowns[k] = []
      missing.push(`${k}: ${describe(s.reason)}`)
      return
    }
    const m = new Map<string, number>()
    for (const r of s.value) {
      const label = String(r.dimensions?.[EXTRAS[k]] ?? '') || 'Unknown'
      m.set(label, (m.get(label) ?? 0) + (r.count ?? 0))
    }
    breakdowns[k] = [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 15)
  })
  const bandwidth = new Map<string, number>()
  if (bw.status === 'fulfilled') {
    for (const r of bw.value) {
      const hour = String(r.dimensions?.datetimeHour ?? '')
      bandwidth.set(hour, (bandwidth.get(hour) ?? 0) + (r.sum?.edgeResponseBytes ?? 0))
    }
  } else missing.push(`bandwidth: ${describe(bw.reason)}`)
  return { ...breakdowns, bandwidthHourly: [...bandwidth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, count]) => ({ hour, count })), missing }
}

export function createAnalyticsHandlers(deps: AnalyticsDeps) {
  const now = deps.now ?? (() => new Date())
  const window = (ms: number): { since: string; until: string } => {
    const until = now().getTime()
    return { since: new Date(until - ms).toISOString(), until: new Date(until).toISOString() }
  }

  /** Undefined if unknown. */
  async function maxSeconds(zoneTag: string): Promise<number | undefined> {
    try {
      const r = await deps.client.graphql<Viewer<{ settings?: Record<string, { maxDuration?: number } | null> }>>(SETTINGS, { zoneTag })
      const s = r.viewer?.zones?.[0]?.settings
      const values = [s?.httpRequestsAdaptiveGroups?.maxDuration, s?.firewallEventsAdaptive?.maxDuration].filter((v): v is number => typeof v === 'number' && v > 0)
      return values.length > 0 ? Math.min(...values) : undefined
    } catch {
      return undefined
    }
  }

  return {
    async zone(raw: unknown): Promise<IpcResult<ZoneAnalytics>> {
      const input = zoneInput.safeParse(raw)
      if (!input.success) return { ok: false, error: 'That request was not valid.' }
      const { zoneId: zoneTag, hours: requestedHours } = input.data
      try {
        const limit = await maxSeconds(zoneTag)
        const hours = limit !== undefined && limit < requestedHours * 3600 ? Math.max(1, Math.floor(limit / 3600)) : requestedHours
        const vars = { zoneTag, ...window(hours * HOUR_MS) }
        const t = await deps.client.graphql<Viewer<{
          totals?: Totals[]
          hourly?: Group<'datetimeHour'>[]
          statuses?: Group<'edgeResponseStatus'>[]
          paths?: Group<'clientRequestPath'>[]
          countries?: Group<'clientCountryName'>[]
        }>>(TRAFFIC, vars)
        const zone = t.viewer?.zones?.[0]
        const totals = zone?.totals?.[0]
        const statuses = counts(zone?.statuses, 'edgeResponseStatus')
        let securityEvents: AnalyticsSecurityEvent[] | null = null
        let securityError: string | null = null
        try {
          const e = await deps.client.graphql<Viewer<{ firewallEventsAdaptive?: Array<Record<string, string | undefined>> }>>(EVENTS, vars)
          securityEvents = (e.viewer?.zones?.[0]?.firewallEventsAdaptive ?? []).map((x) => ({
            datetime: x.datetime ?? '',
            action: x.action ?? '',
            source: x.source ?? '',
            clientIP: x.clientIP ?? '',
            country: x.clientCountryName ?? '',
            path: x.clientRequestPath ?? ''
          }))
        } catch (err) {
          securityError = describe(err)
        }
        const extra = await extras(deps.client, [zoneTag], { since: vars.since, until: vars.until })
        return {
          ok: true,
          value: {
            extra,
            zoneId: zoneTag,
            requestedHours,
            hours,
            requests: totals?.count ?? 0,
            visits: totals?.sum?.visits ?? 0,
            bytes: totals?.sum?.edgeResponseBytes ?? 0,
            hourly: (zone?.hourly ?? []).map((h) => ({ hour: String(h.dimensions?.datetimeHour ?? ''), count: h.count ?? 0 })),
            statuses,
            paths: counts(zone?.paths, 'clientRequestPath'),
            countries: counts(zone?.countries, 'clientCountryName'),
            securityEvents,
            securityError
          }
        }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async global(): Promise<IpcResult<ZoneAnalytics>> {
      try {
        const zones = await deps.client.listZones()
        const vars = window(ANALYTICS_OVERVIEW_HOURS * HOUR_MS)
        const hourly = new Map<string, number>()
        const statuses = new Map<string, number>()
        const paths = new Map<string, number>()
        const countries = new Map<string, number>()
        const add = (m: Map<string, number>, rows: AnalyticsCount[]): void => rows.forEach((r) => void m.set(r.label, (m.get(r.label) ?? 0) + r.count))
        const top = (m: Map<string, number>, n: number): AnalyticsCount[] => [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, n)
        let requests = 0
        let visits = 0
        let bytes = 0
        let failedZones = 0
        let securityEvents: AnalyticsSecurityEvent[] | null = []
        for (let i = 0; i < zones.length; i += ZONES_PER_QUERY) {
          const batch = zones.slice(i, i + ZONES_PER_QUERY)
          try {
            const r = await deps.client.graphql<Viewer<TrafficZone>>(GLOBAL_TRAFFIC, { zoneTags: batch.map((z) => z.id), ...vars })
            for (const z of r.viewer?.zones ?? []) {
              const t = z.totals?.[0]
              requests += t?.count ?? 0
              visits += t?.sum?.visits ?? 0
              bytes += t?.sum?.edgeResponseBytes ?? 0
              add(hourly, counts(z.hourly, 'datetimeHour'))
              add(statuses, counts(z.statuses, 'edgeResponseStatus'))
              add(paths, counts(z.paths, 'clientRequestPath'))
              add(countries, counts(z.countries, 'clientCountryName'))
            }
          } catch (e) {
            if (e instanceof CfApiError && e.status === 401) throw e
            failedZones += batch.length
            continue
          }
          try {
            const e = await deps.client.graphql<Viewer<{ firewallEventsAdaptive?: Array<Record<string, string | undefined>> }>>(GLOBAL_EVENTS, { zoneTags: batch.map((z) => z.id), ...vars })
            for (const z of e.viewer?.zones ?? []) securityEvents?.push(...(z.firewallEventsAdaptive ?? []).map(toEvent))
          } catch {
            securityEvents = null
          }
        }
        const extra = await extras(deps.client, zones.map((z) => z.id), vars)
        return {
          ok: true,
          value: {
            extra,
            zoneId: 'all',
            requestedHours: ANALYTICS_OVERVIEW_HOURS,
            hours: ANALYTICS_OVERVIEW_HOURS,
            requests,
            visits,
            bytes,
            hourly: [...hourly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, count]) => ({ hour, count })),
            statuses: top(statuses, 100),
            paths: top(paths, 10),
            countries: top(countries, 10),
            securityEvents: securityEvents ? securityEvents.sort((a, b) => b.datetime.localeCompare(a.datetime)).slice(0, 50) : null,
            securityError: securityEvents ? null : "Security events couldn't be read for every zone.",
            failedZones
          }
        }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async overview(): Promise<IpcResult<AnalyticsOverviewRow[]>> {
      try {
        const zones = await deps.client.listZones()
        const vars = window(ANALYTICS_OVERVIEW_HOURS * HOUR_MS)
        const rows: AnalyticsOverviewRow[] = []
        for (let i = 0; i < zones.length; i += ZONES_PER_QUERY) {
          const batch = zones.slice(i, i + ZONES_PER_QUERY)
          let error: string | null = null
          const found = new Map<string, Totals | undefined>()
          try {
            const r = await deps.client.graphql<Viewer<{ zoneTag?: string; totals?: Totals[] }>>(OVERVIEW, { zoneTags: batch.map((z) => z.id), ...vars })
            for (const z of r.viewer?.zones ?? []) if (z.zoneTag) found.set(z.zoneTag, z.totals?.[0])
          } catch (e) {
            if (e instanceof CfApiError && e.status === 401) throw e
            error = describe(e)
          }
          for (const z of batch) {
            const t = found.get(z.id)
            rows.push({ zoneId: z.id, zoneName: z.name, requests: error ? null : (t?.count ?? 0), bytes: error ? null : (t?.sum?.edgeResponseBytes ?? 0), error })
          }
        }
        return { ok: true, value: rows }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
