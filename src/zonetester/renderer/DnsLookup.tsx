import { Fragment } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '@app/shared/errorText'
import { DetailList, LevelBadge, SettingMultiple, SettingSingle, SettingText, WarningBox } from '@app/renderer/ui'
import { RECORD_TYPES, RESOLVERS, type Explanation, type LookupResult, type RecordType, type ResolverId } from '../shared/ipc'

const DEFAULT_TYPES: RecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']
const LEVEL_BADGE = { bad: 'Problem', warn: 'Warning', good: 'OK' } as const

function RecordDetail(props: { name: string; type: RecordType; text: string; resolver: ResolverId }): JSX.Element {
  const [value, setValue] = useState<Explanation | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.zonetester
      .explainRecord(props)
      .then((r) => (r.ok ? setValue(r.value) : setError(r.error)))
      .catch((e: unknown) => setError(errorText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.text])
  if (error) return <p role="alert" className="error">{error}</p>
  if (!value) return <p role="status" className="muted">Looking into it...</p>
  return (
    <div className="record-detail">
      <p>{value.summary}</p>
      {value.details.length > 0 && <DetailList rows={value.details} />}
      {value.notes.length > 0 && (
        <ul className="plain-list">
          {value.notes.map((n) => (
            <li key={n.text} className={n.level === 'bad' ? 'error' : ''}><LevelBadge level={n.level}>{LEVEL_BADGE[n.level]}</LevelBadge> {n.text}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DnsLookup(): JSX.Element {
  const [name, setName] = useState('')
  const [types, setTypes] = useState<RecordType[]>(DEFAULT_TYPES)
  const [resolver, setResolver] = useState<ResolverId>('cloudflare')
  const [result, setResult] = useState<LookupResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    setOpen(null)
    try {
      const r = await window.zonetester.dnsLookup({ name: name.trim(), types, resolver })
      if (r.ok) setResult(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && types.length > 0) void run()
        }}
      >
        <SettingText label="Name" help="A domain, such as example.com, or an IP address for a reverse lookup." placeholder="example.com" value={name} onChange={setName} />
        <SettingMultiple label="Record types" options={RECORD_TYPES.map((t) => [t, t] as const)} value={types} onChange={setTypes} />
        <SettingSingle<ResolverId>
          label="Resolver"
          help="Which DNS server answers."
          options={(Object.keys(RESOLVERS) as ResolverId[]).map((id) => [id, RESOLVERS[id].name] as const)}
          value={resolver}
          onChange={setResolver}
        />
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !name.trim() || types.length === 0}>{busy ? 'Looking up...' : 'Look up'}</button>
        </div>
      </form>
      {error && <WarningBox alert>{error}</WarningBox>}
      {result && (
        <>
          <h3>
            {result.name} <span className="muted">via {RESOLVERS[result.resolver].name}</span>
          </h3>
          <div className="table-scroll">
            <table className="zone-table">
              <thead>
                <tr><th>Type</th><th>Answer</th><th>Time</th></tr>
              </thead>
              <tbody>
                {result.results.map((t) =>
                  t.error ? (
                    <tr key={t.type}>
                      <td><span className="badge">{t.type}</span></td>
                      <td className="muted">{t.error}</td>
                      <td className="nowrap muted">{t.ms} ms</td>
                    </tr>
                  ) : (
                    t.records.map((rec, i) => {
                      const key = `${t.type}-${i}`
                      return (
                        <Fragment key={key}>
                          <tr className="clickable" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                            <td>{i === 0 && <span className="badge">{t.type}</span>}</td>
                            <td><code>{rec}</code></td>
                            <td className="nowrap muted">{i === 0 ? `${t.ms} ms` : ''}</td>
                          </tr>
                          {open === key && (
                            <tr>
                              <td colSpan={3}><RecordDetail name={result.name} type={t.type} text={rec} resolver={result.resolver} /></td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })
                  )
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
