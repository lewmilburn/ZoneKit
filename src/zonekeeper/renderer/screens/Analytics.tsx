import { plural } from '@app/shared/plural'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { ANALYTICS_OVERVIEW_HOURS, ANALYTICS_RANGES, type AnalyticsCount, type AnalyticsOverviewRow, type ZoneAnalytics } from '../../shared/ipc'

import { errorText } from '../../shared/errorText'
import { PageHeader, WarningBox, ZoneList, ZoneRow } from '../components/ui'
import { useChildZoneIds } from './Zones'

const GLOBAL_ID = 'all'

// Cleared when the token changes.
let overviewCache: AnalyticsOverviewRow[] | null = null
const zoneCache = new Map<string, ZoneAnalytics>()
let authGeneration = 0
window.zonekeeper.onAuthChanged(() => {
  overviewCache = null
  zoneCache.clear()
  authGeneration++
})

export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

export const rangeLabel = (h: number): string => (h % 24 === 0 ? `${h / 24} ${h === 24 ? 'day' : 'days'}` : `${h} hours`)
const timeLabel = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
}

const W = 720
const H = 160
const BOTTOM = 150

export function HourlyChart({ data, unit = 'requests', format = formatCount }: { data: ZoneAnalytics['hourly']; unit?: string; format?: (n: number) => string }): JSX.Element {
  if (data.length === 0) return <p className="muted">Nothing in this period.</p>
  const max = Math.max(1, ...data.map((d) => d.count))
  const slot = W / data.length
  const barW = Math.max(1, slot - 2)
  return (
    <figure className="chart">
      <div className="chart-max muted">{format(max)} {unit} per hour at peak</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${unit} per hour, peaking at ${max}`} preserveAspectRatio="none">
        <line className="chart-base" x1="0" x2={W} y1={BOTTOM} y2={BOTTOM} />
        {data.map((d, i) => {
          const h = d.count === 0 ? 0 : Math.max(2, (d.count / max) * (BOTTOM - 4))
          const x = i * slot + 1
          const r = Math.min(4, barW / 2, h)
          const top = BOTTOM - h
          return (
            <g key={d.hour} className="chart-slot">
              <rect className="chart-hit" x={i * slot} y="0" width={slot} height={BOTTOM} />
              {h > 0 && <path className="chart-bar" d={`M${x},${BOTTOM}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${BOTTOM}Z`} />}
              <title>{`${timeLabel(d.hour)}: ${format(d.count)} ${unit}`}</title>
            </g>
          )
        })}
      </svg>
      <figcaption className="chart-axis muted">
        <span>{timeLabel(data[0]!.hour)}</span>
        <span>{timeLabel(data[data.length - 1]!.hour)}</span>
      </figcaption>
      <details>
        <summary className="muted">View as table</summary>
        <table className="zone-table">
          <thead><tr><th>Hour</th><th>{unit[0]?.toUpperCase()}{unit.slice(1)}</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.hour}><td>{timeLabel(d.hour)}</td><td>{format(d.count)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  )
}

export function BarChart({ title, rows, unit = 'events' }: { title: string; rows: AnalyticsCount[]; unit?: string }): JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r.count))
  const total = rows.reduce((a, r) => a + r.count, 0)
  return (
    <figure className="chart">
      <h4>{title}</h4>
      {rows.length === 0 && <p className="muted">No data.</p>}
      <div className="bar-chart" role="list">
        {rows.map((r) => (
          <div key={r.label} className="bar-row" role="listitem" title={`${r.label}: ${r.count.toLocaleString()} ${unit} (${((r.count / Math.max(1, total)) * 100).toFixed(1)}%)`}>
            <span className="bar-label">{r.label}</span>
            <span className="bar-track"><span className="bar-fill" style={{ width: `${(r.count / max) * 100}%`, display: 'block' }} /></span>
            <span className="bar-value">{r.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </figure>
  )
}

export function TopList({ title, rows }: { title: string; rows: AnalyticsCount[] }): JSX.Element {
  return (
    <section className="top-list">
      <h4>{title}</h4>
      {rows.length === 0 && <p className="muted">No data.</p>}
      <table className="zone-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="top-label">{r.label}</td>
              <td className="num">{r.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function ZonePage({ zone, onBack }: { zone: { id: string; name: string }; onBack: () => void }): JSX.Element {
  const isGlobal = zone.id === GLOBAL_ID
  const [hours, setHours] = useState<number>(ANALYTICS_OVERVIEW_HOURS)
  const key = `${zone.id}:${hours}`
  const [data, setData] = useState<ZoneAnalytics | null>(zoneCache.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const latest = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const id = ++latest.current
    const generation = authGeneration
    setLoading(true)
    setError(null)
    try {
      const r = isGlobal ? await window.zonekeeper.analyticsGlobal() : await window.zonekeeper.analyticsZone({ zoneId: zone.id, hours })
      if (r.ok && generation === authGeneration) zoneCache.set(`${zone.id}:${hours}`, r.value)
      if (id !== latest.current) return
      if (r.ok) setData(r.value)
      else setError(r.error)
    } catch (e) {
      if (id === latest.current) setError(errorText(e))
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [zone.id, hours, isGlobal])

  useEffect(() => {
    const cached = zoneCache.get(key)
    setData(cached ?? null)
    if (!cached) void load()
    return () => {
      latest.current++
    }
  }, [key, load])

  const errors = data ? data.statuses.filter((s) => /^[45]/.test(s.label)).reduce((a, s) => a + s.count, 0) : 0
  const total = data ? data.statuses.reduce((a, s) => a + s.count, 0) : 0

  return (
    <div className="analytics zone-page">
      <PageHeader title={zone.name} onBack={onBack} />
      <div className="actions">
        {isGlobal && <span className="muted">Last {rangeLabel(ANALYTICS_OVERVIEW_HOURS)}</span>}
        {!isGlobal && ANALYTICS_RANGES.map((h) => (
          <button key={h} className={h === hours ? 'chosen' : ''} aria-pressed={h === hours} onClick={() => setHours(h)}>{rangeLabel(h)}</button>
        ))}
        <button onClick={() => void load()} disabled={loading}>Refresh</button>
        <span className="muted" role="status">{loading ? 'Loading...' : ''}</span>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {data && (
        <>
          {(data.failedZones ?? 0) > 0 && <WarningBox>{plural(data.failedZones ?? 0, 'zone')} could not be read, so they are missing from these totals.</WarningBox>}
          {isGlobal && <p className="muted">Top lists combine each zone&apos;s top 10, so they are approximate.</p>}
          {data.hours < data.requestedHours && (
            <WarningBox>This zone&apos;s plan limits analytics, so this shows the last {rangeLabel(data.hours)} instead of {rangeLabel(data.requestedHours)}.</WarningBox>
          )}
          <div className="tiles">
            <div className="tile"><span className="tile-value">{formatCount(data.requests)}</span><span className="muted">Requests</span></div>
            <div className="tile"><span className="tile-value">{formatCount(data.visits)}</span><span className="muted">Visits</span></div>
            <div className="tile"><span className="tile-value">{formatBytes(data.bytes)}</span><span className="muted">Bandwidth</span></div>
            <div className="tile"><span className="tile-value">{total === 0 ? '-' : `${((errors / total) * 100).toFixed(1)}%`}</span><span className="muted">4xx and 5xx</span></div>
          </div>
          <h3>Requests per hour</h3>
          <HourlyChart data={data.hourly} />
          {data.extra && data.extra.bandwidthHourly.length > 0 && (
            <>
              <h3>Bandwidth per hour</h3>
              <HourlyChart data={data.extra.bandwidthHourly} unit="served" format={formatBytes} />
            </>
          )}
          {data.extra && data.extra.missing.length > 0 && <WarningBox>Some breakdowns aren&apos;t available on this plan: {data.extra.missing.join('; ')}</WarningBox>}
          <div className="top-grid">
            <BarChart title="Status codes" rows={data.statuses.slice(0, 10)} unit="requests" />
            <BarChart title="Countries" rows={data.countries} unit="requests" />
            {data.extra && <BarChart title="Cache status" rows={data.extra.cache} unit="requests" />}
            {data.extra && <BarChart title="Devices" rows={data.extra.devices} unit="requests" />}
            {data.extra && <BarChart title="Browsers" rows={data.extra.browsers} unit="requests" />}
            {data.extra && <BarChart title="Operating systems" rows={data.extra.os} unit="requests" />}
            {data.extra && <BarChart title="HTTP versions" rows={data.extra.protocols} unit="requests" />}
            {data.extra && <BarChart title="Content types" rows={data.extra.contentTypes} unit="requests" />}
          </div>
          <div className="top-grid">
            <TopList title="Top paths" rows={data.paths} />
            {data.extra && <TopList title="Hosts" rows={data.extra.hosts} />}
            {data.extra && <TopList title="Referrers" rows={data.extra.referers} />}
            {data.extra && <TopList title="Methods" rows={data.extra.methods} />}
          </div>
          <h3>Security events</h3>
          {data.securityError && <WarningBox alert>{data.securityError}</WarningBox>}
          {data.securityEvents?.length === 0 && <p className="muted">No security events in this period.</p>}
          {data.securityEvents && data.securityEvents.length > 0 && (
            <div className="table-scroll">
              <table className="zone-table">
                <thead><tr><th>Time</th><th>Action</th><th>Source</th><th>IP</th><th>Country</th><th>Path</th></tr></thead>
                <tbody>
                  {data.securityEvents.map((e, i) => (
                    <tr key={`${e.datetime}-${i}`}>
                      <td>{new Date(e.datetime).toLocaleString()}</td><td>{e.action}</td><td>{e.source}</td><td>{e.clientIP}</td><td>{e.country}</td><td className="top-label">{e.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">Cloudflare samples this data on most plans, so the figures can be estimates.</p>
        </>
      )}
    </div>
  )
}

export function Analytics({ resetSignal = 0 }: { resetSignal?: number }): JSX.Element {
  const [rows, setRows] = useState<AnalyticsOverviewRow[] | null>(overviewCache)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(overviewCache === null)
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null)
  const childIds = useChildZoneIds()
  const latest = useRef(0)

  useEffect(() => {
    if (resetSignal > 0) setOpen(null)
  }, [resetSignal])

  const load = useCallback(async (): Promise<void> => {
    const id = ++latest.current
    const generation = authGeneration
    setLoading(true)
    setError(null)
    try {
      const r = await window.zonekeeper.analyticsOverview()
      if (r.ok && generation === authGeneration) overviewCache = r.value
      if (id !== latest.current) return
      if (r.ok) setRows(r.value)
      else setError(r.error)
    } catch (e) {
      if (id === latest.current) setError(errorText(e))
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (overviewCache === null) void load()
    return () => {
      latest.current++
    }
  }, [load])

  if (open) return <ZonePage key={open.id} zone={open} onBack={() => setOpen(null)} />

  const sorted = rows ? rows.filter((r) => !childIds.has(r.zoneId)).sort((a, b) => (b.requests ?? -1) - (a.requests ?? -1) || a.zoneName.localeCompare(b.zoneName)) : []
  return (
    <div className="analytics">
      <div className="actions">
        <button onClick={() => void load()} disabled={loading}>Refresh</button>
        <span className="muted" role="status">{loading ? 'Loading...' : `Last ${rangeLabel(ANALYTICS_OVERVIEW_HOURS)}`}</span>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {rows && rows.length === 0 && <p>No zones found for this token</p>}
      {sorted.length > 0 && (
        <ZoneList>
          <ZoneRow
            name={<strong>All zones</strong>}
            meta={<span className="badge">{formatCount(sorted.reduce((a, r) => a + (r.requests ?? 0), 0))} requests</span>}
            onOpen={() => setOpen({ id: GLOBAL_ID, name: 'All zones' })}
          />
          {sorted.map((r) => (
            <ZoneRow
              key={r.zoneId}
              name={r.zoneName}
              onOpen={() => setOpen({ id: r.zoneId, name: r.zoneName })}
              meta={r.error ? <span className="badge">Unavailable</span> : (
                <>
                  <span className="muted">{formatBytes(r.bytes ?? 0)}</span>
                  <span className="badge">{formatCount(r.requests ?? 0)} requests</span>
                </>
              )}
            />
          ))}
        </ZoneList>
      )}
    </div>
  )
}
