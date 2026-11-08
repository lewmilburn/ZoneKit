import { plural } from '@app/shared/plural'
import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { LogRow, LogsView } from '../../shared/ipc'
import { Fragment } from 'preact'
import { ButtonGroup, DetailList, Tabs, WarningBox } from '../components/ui'
import { ZoneScope } from '../components/ZoneScope'
import { Analytics } from './Analytics'
import { DnsAnalytics } from './DnsAnalytics'
import { getZones } from './Zones'

function Logs(): JSX.Element {
  return <ZoneScope>{(s) => <LogsReport zoneIds={s.zoneIds} />}</ZoneScope>
}

function LogsReport({ zoneIds }: { zoneIds: string[] }): JSX.Element {
  const [hours, setHours] = useState<1 | 6 | 24>(1)
  const [statusClass, setStatusClass] = useState('all')
  const [open, setOpen] = useState<number | null>(null)
  const [rows, setRows] = useState<LogRow[] | null>(null)
  const [failed, setFailed] = useState<LogsView['failed']>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void getZones().then((r) => r.ok && setNames(Object.fromEntries(r.value.map((z) => [z.id, z.name]))))
  }, [])

  async function load(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const r = await window.zonekeeper.logsQuery({ zoneIds, hours })
      if (r.ok) {
        setRows(r.value.rows)
        setFailed(r.value.failed)
      } else {
        setRows(null)
        setFailed([])
        setError(r.error)
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneIds.join(','), hours])

  const needle = filter.toLowerCase()
  const shown = (rows ?? [])
    .filter((r) => statusClass === 'all' || r.status.startsWith(statusClass))
    .filter((r) => needle === '' || Object.values(r).some((v) => v.toLowerCase().includes(needle)))

  return (
    <div>
      {failed.length > 0 && (
        <WarningBox>
          Logs couldn&apos;t be read for {plural(failed.length, 'zone')}:
          <ul className="plain-list">
            {failed.map((f) => <li key={f.zoneId}>{names[f.zoneId] ?? f.zoneId}: {f.error}</li>)}
          </ul>
        </WarningBox>
      )}
      <div className="actions">
        <ButtonGroup label="Period" options={[['1', '1 hour'], ['6', '6 hours'], ['24', '24 hours']] as const} value={String(hours) as '1' | '6' | '24'} onChange={(v) => setHours(Number(v) as 1 | 6 | 24)} />
        <ButtonGroup label="Status" options={[['all', 'All'], ['2', '2xx'], ['3', '3xx'], ['4', '4xx'], ['5', '5xx']] as const} value={statusClass} onChange={(v) => { setStatusClass(v); setOpen(null) }} />
        <input aria-label="Filter logs" placeholder="Filter" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
        <button disabled={loading} onClick={() => void load()}>Refresh</button>
        <span className="muted" role="status">{loading ? 'Loading...' : rows ? `${shown.length} of ${rows.length} requests` : ''}</span>
      </div>
      {error && <WarningBox alert>{error}</WarningBox>}
      {rows?.length === 0 && <p className="muted">No requests in this period.</p>}
      {shown.length > 0 && (
        <div className="table-scroll">
          <table className="zone-table">
            <thead><tr><th>Time</th><th>Status</th><th>Method</th><th>Host and path</th><th>Cache</th><th>IP</th><th>Country</th><th /></tr></thead>
            <tbody>
              {shown.map((r, i) => (
                <Fragment key={`${r.rayId || r.time}-${i}`}>
                  <tr>
                    <td className="nowrap">{new Date(r.time).toLocaleString()}</td><td>{r.status}</td><td>{r.method}</td><td className="top-label">{r.host}{r.uri}</td><td>{r.cache}</td><td>{r.ip}</td><td>{r.country}</td>
                    <td><button className="link" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Hide' : 'Details'}</button></td>
                  </tr>
                  {open === i && (
                    <tr>
                      <td colSpan={8}>
                        <DetailList
                          rows={[
                            ['Ray ID', r.rayId], ['URL', `${r.host}${r.uri}`], ['Protocol', r.protocol], ['Content type', r.contentType],
                            ['Size', r.bytes && `${Number(r.bytes).toLocaleString()} bytes`], ['Time to first byte', r.ttfbMs && `${r.ttfbMs} ms`],
                            ['Cache', r.cache], ['Referer', r.referer], ['Network', r.asn], ['User agent', r.userAgent]
                          ]}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function AnalyticsScreen({ resetSignal }: { resetSignal: number }): JSX.Element {
  const [tab, setTab] = useState<'analytics' | 'dns' | 'logs'>('analytics')
  return (
    <div>
      <Tabs tabs={[['analytics', 'Analytics'], ['dns', 'DNS'], ['logs', 'Logs']] as const} active={tab} onChange={setTab} />
      {tab === 'analytics' ? <Analytics resetSignal={resetSignal} /> : tab === 'dns' ? <DnsAnalytics /> : <Logs />}
    </div>
  )
}
