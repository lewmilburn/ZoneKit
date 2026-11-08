import { plural } from '@app/shared/plural'
import { Fragment } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import { WAF_RANGES, type WafAnalytics as Data, type WafEvent } from '../../shared/ipc'
import { ButtonGroup, DetailList, WarningBox } from '../components/ui'
import { ZoneScope } from '../components/ZoneScope'
import { BarChart, formatCount, HourlyChart, rangeLabel, TopList } from './Analytics'

type Hours = (typeof WAF_RANGES)[number]
const cache = new Map<string, Data>()

function EventDetail({ e }: { e: WafEvent }): JSX.Element {
  return (
    <DetailList
      rows={[['Rule', e.rule], ['Rule ID', e.ruleId], ['Ray ID', e.rayId], ['Host', e.host], ['Path', e.path], ['Method', e.method], ['Status', e.status], ['IP', e.clientIP], ['Network', e.asn], ['Country', e.country], ['User agent', e.userAgent]]}
    />
  )
}

function Report({ zoneIds, cacheKey }: { zoneIds: string[]; cacheKey: string }): JSX.Element {
  const [hours, setHours] = useState<Hours>(24)
  const key = `${cacheKey}:${hours}`
  const [data, setData] = useState<Data | null>(cache.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0)
  const ids = zoneIds.join(',')

  useEffect(() => {
    const cached = refresh === 0 ? cache.get(key) : undefined
    setData(cached ?? null)
    setOpen(null)
    if (cached) return
    let live = true
    setLoading(true)
    setError(null)
    void window.zonekeeper
      .analyticsWaf({ zoneIds, hours })
      .then((r) => {
        if (!live) return
        if (r.ok) {
          cache.set(key, r.value)
          setData(r.value)
        } else setError(r.error)
      })
      .catch((e: unknown) => live && setError(errorText(e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ids, refresh])

  const blocked = data ? data.actions.filter((a) => /block|drop|challenge|jschallenge|managed_challenge/.test(a.label)).reduce((n, a) => n + a.count, 0) : 0

  return (
    <div className="analytics">
      <div className="actions">
        <ButtonGroup<string> label="Time range" options={WAF_RANGES.map((h) => [String(h), h < 24 ? `${h} hour${h === 1 ? '' : 's'}` : rangeLabel(h)] as const)} value={String(hours)} onChange={(v) => setHours(Number(v) as Hours)} />
        <button onClick={() => setRefresh((n) => n + 1)} disabled={loading}>Refresh</button>
        <span className="muted" role="status">{loading ? 'Loading...' : ''}</span>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {data && (
        <>
          {data.hours < data.requestedHours && <WarningBox>This zone&apos;s plan limits security analytics, so this shows the last {rangeLabel(data.hours)}.</WarningBox>}
          {data.sampled && <WarningBox>Your plan doesn&apos;t include grouped security analytics, so these counts come from the latest events only and may be lower than the real totals.</WarningBox>}
          {data.failedZones > 0 && <WarningBox>{plural(data.failedZones, 'zone')} could not be read: {data.failedReason}</WarningBox>}
          <div className="tiles">
            <div className="tile"><span className="tile-value">{formatCount(data.total)}</span><span className="muted">Security events</span></div>
            <div className="tile"><span className="tile-value">{formatCount(blocked)}</span><span className="muted">Blocked or challenged</span></div>
            <div className="tile"><span className="tile-value">{formatCount(data.ips.length)}{data.ips.length === 10 ? '+' : ''}</span><span className="muted">Distinct IPs</span></div>
            <div className="tile"><span className="tile-value">{formatCount(data.countries.length)}{data.countries.length === 10 ? '+' : ''}</span><span className="muted">Countries</span></div>
          </div>
          <h3>Events per hour</h3>
          <HourlyChart unit="events" data={data.hourly.map((h) => ({ hour: h.hour, count: Object.values(h.byAction).reduce((a, b) => a + b, 0) }))} />
          <div className="top-grid">
            <BarChart title="Actions" rows={data.actions} />
            <BarChart title="Services" rows={data.sources} />
            <BarChart title="Rules" rows={data.rules} />
            <BarChart title="Countries" rows={data.countries} />
            <BarChart title="Methods" rows={data.methods} />
          </div>
          <div className="top-grid">
            <TopList title="Top IPs" rows={data.ips} />
            <TopList title="Networks (ASN)" rows={data.asns} />
            <TopList title="Paths" rows={data.paths} />
            <TopList title="Hosts" rows={data.hosts} />
            <TopList title="User agents" rows={data.userAgents} />
          </div>
          <h3>Latest events</h3>
          {data.events.length === 0 && <p className="muted">No security events in this period.</p>}
          {data.events.length > 0 && (
            <div className="table-scroll">
              <table className="zone-table">
                <thead><tr><th>Time</th><th>Action</th><th>Service</th><th>IP</th><th>Country</th><th>Host and path</th><th /></tr></thead>
                <tbody>
                  {data.events.map((e, i) => (
                    <Fragment key={`${e.rayId}-${i}`}>
                      <tr>
                        <td className="nowrap">{new Date(e.datetime).toLocaleString()}</td>
                        <td>{e.action}</td>
                        <td>{e.source}</td>
                        <td>{e.clientIP}</td>
                        <td>{e.country}</td>
                        <td className="top-label">{e.host}{e.path}</td>
                        <td><button className="link" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Hide' : 'Details'}</button></td>
                      </tr>
                      {open === i && <tr><td colSpan={7}><EventDetail e={e} /></td></tr>}
                    </Fragment>
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

export function WafAnalytics(): JSX.Element {
  return <ZoneScope>{(s) => <Report zoneIds={s.zoneIds} cacheKey={s.key} />}</ZoneScope>
}
