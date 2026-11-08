import { describe, expect, it } from 'vitest'
import { createAnalyticsHandlers, ZONES_PER_QUERY } from '../../src/zonekeeper/main/analytics'
import { CfApiError } from '../../src/zonekeeper/main/cloudflare/client'

const now = () => new Date('2026-11-07T12:00:00Z')
const zones = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `z${i}`, name: `z${i}.com` }))

function setup(graphql: (q: string, v: Record<string, unknown>) => unknown, count = 1) {
  const calls: Array<{ q: string; v: Record<string, unknown> }> = []
  const handlers = createAnalyticsHandlers({
    now,
    client: {
      listZones: async () => zones(count) as never,
      graphql: (async (q: string, v: Record<string, unknown>) => {
        calls.push({ q, v })
        return graphql(q, v)
      }) as never
    }
  })
  return { handlers, calls }
}

const traffic = { viewer: { zones: [{ totals: [{ count: 5, sum: { edgeResponseBytes: 10, visits: 2 } }], hourly: [], statuses: [], paths: [], countries: [] }] } }

describe('analytics', () => {
  it('splits many zones into batches of at most 10', async () => {
    const { handlers, calls } = setup(() => ({ viewer: { zones: [] } }), 25)
    const r = await handlers.overview()
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => (c.v.zoneTags as string[]).length <= ZONES_PER_QUERY)).toBe(true)
    expect(r.ok && r.value).toHaveLength(25)
  })

  it('reduces and flags a range beyond the zone limit', async () => {
    const { handlers, calls } = setup((q) => (q.includes('settings') ? { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: { maxDuration: 86400 }, firewallEventsAdaptive: { maxDuration: 259200 } } }] } } : traffic))
    const r = await handlers.zone({ zoneId: 'z1', hours: 168 })
    expect(r.ok && [r.value.requestedHours, r.value.hours]).toEqual([168, 24])
    expect(calls[1]!.v.since).toBe('2026-11-06T12:00:00.000Z')
  })

  it('keeps traffic when security events fail', async () => {
    const { handlers } = setup((q) => {
      if (q.includes('firewallEventsAdaptive(')) throw new CfApiError(403, 'no')
      return q.includes('settings') ? {} : traffic
    })
    const r = await handlers.zone({ zoneId: 'z1', hours: 24 })
    expect(r.ok && r.value.requests).toBe(5)
    expect(r.ok && r.value.securityEvents).toBeNull()
    expect(r.ok && r.value.securityError).toContain('Analytics Read')
  })

  it('marks a failed batch as unavailable, not zero', async () => {
    const { handlers } = setup(() => {
      throw new CfApiError(400, 'bad')
    })
    const r = await handlers.overview()
    expect(r.ok && r.value[0]!.requests).toBeNull()
    expect(r.ok && r.value[0]!.error).toBeTruthy()
  })

  it('combines all zones and counts failed batches', async () => {
    let batch = 0
    const zone = { totals: [{ count: 5, sum: { edgeResponseBytes: 10, visits: 2 } }], hourly: [{ count: 1, dimensions: { datetimeHour: 'h1' } }], statuses: [], paths: [{ count: 3, dimensions: { clientRequestPath: '/a' } }], countries: [] }
    const { handlers } = setup((q) => {
      if (q.includes('firewallEventsAdaptive(')) return { viewer: { zones: [] } }
      if (++batch === 2) throw new CfApiError(400, 'bad')
      return { viewer: { zones: [zone, zone] } }
    }, 11)
    const r = await handlers.global()
    expect(r.ok && r.value.requests).toBe(10)
    expect(r.ok && r.value.hourly).toEqual([{ hour: 'h1', count: 2 }])
    expect(r.ok && r.value.paths[0]).toEqual({ label: '/a', count: 6 })
    expect(r.ok && r.value.failedZones).toBe(1)
  })

  it('rejects invalid input without calling Cloudflare', async () => {
    const { handlers, calls } = setup(() => traffic)
    expect((await handlers.zone({ zoneId: 'z1', hours: 5 })).ok).toBe(false)
    expect(calls).toEqual([])
  })
})
