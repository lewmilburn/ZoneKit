import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import { WAF_RANGES, type DnsAnalytics as Data } from '../../shared/ipc'
import { ButtonGroup, WarningBox } from '../components/ui'
import { ZoneScope } from '../components/ZoneScope'
import { BarChart, formatCount, HourlyChart, rangeLabel, TopList } from './Analytics'

type Hours = (typeof WAF_RANGES)[number]
const cache = new Map<string, Data>()
const share = (rows: Data['codes'], test: (label: string) => boolean, total: number): string =>
  total === 0 ? '-' : `${((rows.filter((r) => test(r.label)).reduce((a, r) => a + r.count, 0) / total) * 100).toFixed(1)}%`

function Report({ zoneIds, cacheKey }: { zoneIds: string[]; cacheKey: string }): JSX.Element {
  const [hours, setHours] = useState<Hours>(24)
  const key = `${cacheKey}:${hours}`
  const [data, setData] = useState<Data | null>(cache.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    const cached = refresh === 0 ? cache.get(key) : undefined
    setData(cached ?? null)
    if (cached) return
    let live = true
    setLoading(true)
    setError(null)
    void window.zonekeeper
      .analyticsDns({ zoneIds, hours })
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
  }, [key, refresh])

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
          {data.missing.length > 0 && <WarningBox>Some breakdowns couldn&apos;t be read: {data.missing.join('; ')}</WarningBox>}
          <div className="tiles">
            <div className="tile"><span className="tile-value">{formatCount(data.total)}</span><span className="muted">DNS queries</span></div>
            <div className="tile"><span className="tile-value">{share(data.codes, (l) => l === 'NXDOMAIN', data.total)}</span><span className="muted">NXDOMAIN</span></div>
            <div className="tile"><span className="tile-value">{share(data.codes, (l) => l === 'SERVFAIL', data.total)}</span><span className="muted">SERVFAIL</span></div>
            <div className="tile"><span className="tile-value">{share(data.cached, (l) => l === 'Cached', data.total)}</span><span className="muted">Answered from cache</span></div>
          </div>
          <h3>Queries per hour</h3>
          <HourlyChart unit="queries" data={data.hourly} />
          <div className="top-grid">
            <BarChart title="Record types" rows={data.types} unit="queries" />
            <BarChart title="Response codes" rows={data.codes} unit="queries" />
          </div>
          <div className="top-grid">
            <TopList title="Names queried" rows={data.names} />
            <TopList title="Data centres" rows={data.colos} />
            <TopList title="Protocols" rows={data.protocols} />
            <TopList title="IP versions" rows={data.ipVersions} />
          </div>
          <p className="muted">Cloudflare samples this data on most plans, so the figures can be estimates.</p>
        </>
      )}
    </div>
  )
}

export function DnsAnalytics(): JSX.Element {
  return <ZoneScope>{(s) => <Report zoneIds={s.zoneIds} cacheKey={s.key} />}</ZoneScope>
}
