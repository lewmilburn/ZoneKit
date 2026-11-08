import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { AnalyticsCount, IpcResult, WafAnalytics, WafEvent } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'

const HOUR_MS = 3_600_000
/** Cloudflare's limit. */
const ZONES_PER_QUERY = 10

const input = z.strictObject({
  zoneIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(1000),
  hours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(72), z.literal(168)])
})

const LIMIT = `query($zoneTags: [string!]) { viewer { zones(filter: { zoneTag_in: $zoneTags }) { settings {
  firewallEventsAdaptiveGroups { maxDuration }
  firewallEventsAdaptive { maxDuration }
} } } }`

const group = (alias: string, dims: string, limit = 10): string =>
  `${alias}: firewallEventsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: ${limit}, orderBy: [count_DESC]) { count dimensions { ${dims} } }`

const GROUPS = `query($zoneTags: [string!], $since: Time, $until: Time) { viewer { zones(filter: { zoneTag_in: $zoneTags }) {
  hourly: firewallEventsAdaptiveGroups(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 1000, orderBy: [datetimeHour_ASC]) { count dimensions { datetimeHour action } }
  ${group('actions', 'action', 20)}
  ${group('sources', 'source', 20)}
  ${group('rules', 'ruleId description source', 15)}
  ${group('ips', 'clientIP')}
  ${group('countries', 'clientCountryName')}
  ${group('asns', 'clientAsn clientASNDescription')}
  ${group('paths', 'clientRequestPath')}
  ${group('hosts', 'clientRequestHTTPHost')}
  ${group('agents', 'userAgent')}
  ${group('methods', 'clientRequestHTTPMethodName')}
} } }`

const EVENTS = `query($zoneTags: [string!], $since: Time, $until: Time, $limit: uint64!) { viewer { zones(filter: { zoneTag_in: $zoneTags }) {
  events: firewallEventsAdaptive(filter: { datetime_geq: $since, datetime_leq: $until }, limit: $limit, orderBy: [datetime_DESC]) {
    datetime action source ruleId description rayName clientIP clientCountryName clientAsn clientASNDescription
    clientRequestHTTPMethodName clientRequestHTTPHost clientRequestPath clientRequestQuery userAgent edgeResponseStatus
  }
} } }`

type Dim = Record<string, string | number | undefined>
type Grp = { count?: number; dimensions?: Dim }
type GroupZone = Record<'hourly' | 'actions' | 'sources' | 'rules' | 'ips' | 'countries' | 'asns' | 'paths' | 'hosts' | 'agents' | 'methods', Grp[] | undefined>
type Viewer<T> = { viewer?: { zones?: T[] } }

function describe(e: unknown): string {
  if (e instanceof CfApiError && e.status === 401) return 'Cloudflare rejected your API token.'
  if (e instanceof CfApiError && e.status === 403) return 'Your token needs the Analytics Read permission.'
  return errorText(e)
}

const str = (v: string | number | undefined): string => (v === undefined || v === '' ? '' : String(v))

const asn = (d: Dim): string => [str(d.clientAsn) && `AS${str(d.clientAsn)}`, str(d.clientASNDescription)].filter(Boolean).join(' ')
const LABELS: ReadonlyArray<readonly [Exclude<keyof GroupZone, 'hourly'>, (d: Dim) => string]> = [
  ['actions', (d) => str(d.action)],
  ['sources', (d) => str(d.source)],
  ['rules', (d) => [str(d.description) || str(d.ruleId), str(d.source)].filter(Boolean).join(' · ')],
  ['ips', (d) => str(d.clientIP)],
  ['countries', (d) => str(d.clientCountryName)],
  ['asns', asn],
  ['paths', (d) => str(d.clientRequestPath)],
  ['hosts', (d) => str(d.clientRequestHTTPHost)],
  ['agents', (d) => str(d.userAgent)],
  ['methods', (d) => str(d.clientRequestHTTPMethodName)]
]
/** Per batch, when counting raw events. */
const RAW_LIMIT = 2000

class Tally {
  private m = new Map<string, number>()
  add(label: string, n: number): void {
    this.m.set(label || 'Unknown', (this.m.get(label || 'Unknown') ?? 0) + n)
  }
  top(n: number): AnalyticsCount[] {
    return [...this.m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, n)
  }
}

export function createWafAnalyticsHandler(deps: { client: Pick<CfClient, 'graphql'>; now?: () => Date }) {
  const now = deps.now ?? (() => new Date())

  async function maxHours(zoneTags: string[]): Promise<number | undefined> {
    try {
      const r = await deps.client.graphql<Viewer<{ settings?: Record<string, { maxDuration?: number } | null> }>>(LIMIT, { zoneTags: zoneTags.slice(0, ZONES_PER_QUERY) })
      const all = (r.viewer?.zones ?? []).flatMap((z) => Object.values(z.settings ?? {}).map((s) => s?.maxDuration ?? 0)).filter((v) => v > 0)
      return all.length > 0 ? Math.max(1, Math.floor(Math.min(...all) / 3600)) : undefined
    } catch {
      return undefined
    }
  }

  return async (raw: unknown): Promise<IpcResult<WafAnalytics>> => {
    const i = input.safeParse(raw)
    if (!i.success) return { ok: false, error: 'That request was not valid.' }
    const { zoneIds, hours: requestedHours } = i.data
    try {
      const limit = await maxHours(zoneIds)
      const hours = limit !== undefined && limit < requestedHours ? limit : requestedHours
      const until = now()
      const vars = { since: new Date(until.getTime() - hours * HOUR_MS).toISOString(), until: until.toISOString() }

      const t = Object.fromEntries(['actions', 'sources', 'rules', 'ips', 'countries', 'asns', 'paths', 'hosts', 'agents', 'methods'].map((k) => [k, new Tally()])) as Record<string, Tally>
      const hourly = new Map<string, Record<string, number>>()
      const events: WafEvent[] = []
      let failedZones = 0
      let sampled = false
      let lastError: unknown = null

      for (let b = 0; b < zoneIds.length; b += ZONES_PER_QUERY) {
        const zoneTags = zoneIds.slice(b, b + ZONES_PER_QUERY)
        try {
          // Grouped counts need a paid plan: fall back to raw events
          const g = await deps.client.graphql<Viewer<GroupZone>>(GROUPS, { zoneTags, ...vars }).catch((err: unknown) => {
            if (err instanceof CfApiError && err.status === 401) throw err
            return null
          })
          const e = await deps.client.graphql<Viewer<{ events?: Dim[] }>>(EVENTS, { zoneTags, ...vars, limit: g ? 100 : RAW_LIMIT })
          if (!g) sampled = true
          for (const z of g?.viewer?.zones ?? []) {
            for (const h of z.hourly ?? []) {
              const hour = str(h.dimensions?.datetimeHour)
              const row = hourly.get(hour) ?? {}
              const action = str(h.dimensions?.action) || 'unknown'
              row[action] = (row[action] ?? 0) + (h.count ?? 0)
              hourly.set(hour, row)
            }
            const each = (key: keyof GroupZone, label: (d: Dim) => string): void => {
              for (const r of z[key] ?? []) t[key]?.add(label(r.dimensions ?? {}), r.count ?? 0)
            }
            for (const [key, label] of LABELS) each(key, label)
          }
          for (const z of g ? [] : e.viewer?.zones ?? []) {
            for (const x of z.events ?? []) {
              const hour = `${str(x.datetime).slice(0, 13)}:00:00Z`
              const row = hourly.get(hour) ?? {}
              const action = str(x.action) || 'unknown'
              row[action] = (row[action] ?? 0) + 1
              hourly.set(hour, row)
              for (const [key, label] of LABELS) t[key]?.add(label(x), 1)
            }
          }
          for (const z of e.viewer?.zones ?? []) {
            for (const x of z.events ?? []) {
              events.push({
                datetime: str(x.datetime),
                action: str(x.action),
                source: str(x.source),
                rule: str(x.description) || str(x.ruleId),
                ruleId: str(x.ruleId),
                rayId: str(x.rayName),
                clientIP: str(x.clientIP),
                country: str(x.clientCountryName),
                asn: [str(x.clientAsn) && `AS${str(x.clientAsn)}`, str(x.clientASNDescription)].filter(Boolean).join(' '),
                method: str(x.clientRequestHTTPMethodName),
                host: str(x.clientRequestHTTPHost),
                path: `${str(x.clientRequestPath)}${str(x.clientRequestQuery)}`,
                userAgent: str(x.userAgent),
                status: str(x.edgeResponseStatus)
              })
            }
          }
        } catch (err) {
          if (err instanceof CfApiError && err.status === 401) throw err
          failedZones += zoneTags.length
          lastError = err
        }
      }
      if (failedZones === zoneIds.length && lastError) return { ok: false, error: describe(lastError) }

      const actions = t.actions!.top(20)
      return {
        ok: true,
        value: {
          requestedHours,
          hours,
          total: actions.reduce((a, r) => a + r.count, 0),
          actions,
          hourly: [...hourly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, byAction]) => ({ hour, byAction })),
          sources: t.sources!.top(20),
          rules: t.rules!.top(15),
          ips: t.ips!.top(10),
          countries: t.countries!.top(10),
          asns: t.asns!.top(10),
          paths: t.paths!.top(10),
          hosts: t.hosts!.top(10),
          userAgents: t.agents!.top(10),
          methods: t.methods!.top(10),
          events: events.sort((a, b) => b.datetime.localeCompare(a.datetime)).slice(0, 100),
          failedZones,
          sampled,
          ...(failedZones > 0 && lastError ? { failedReason: describe(lastError) } : {})
        }
      }
    } catch (e) {
      return { ok: false, error: describe(e) }
    }
  }
}
