import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '@app/shared/errorText'
import { DetailList, LevelBadge, SettingText, WarningBox } from '@app/renderer/ui'
import type { TlsResult } from '../shared/ipc'
import { TestsslScan } from './TestsslScan'

const LEVEL_BADGE = { bad: 'Insecure', warn: 'Warning', good: 'OK' } as const
const VERSION_NAMES = { TLSv1: 'TLS 1.0', 'TLSv1.1': 'TLS 1.1', 'TLSv1.2': 'TLS 1.2', 'TLSv1.3': 'TLS 1.3' } as const

export function TlsTester(): JSX.Element {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('443')
  const [result, setResult] = useState<TlsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await window.zonetester.testTls({ host: host.trim(), port: Number(port) })
      if (r.ok) setResult(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const c = result?.certificate
  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (host.trim()) void run()
        }}
      >
        <SettingText label="Host" placeholder="example.com" value={host} onChange={setHost} />
        <SettingText label="Port" type="number" value={port} onChange={setPort} />
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !host.trim()}>{busy ? 'Testing...' : 'Test TLS'}</button>
        </div>
      </form>
      {error && <WarningBox alert>{error}</WarningBox>}
      {result && (
        <>
          <h3>{result.host}:{result.port}</h3>
          <ul className="plain-list">
            {result.findings.map((f) => (
              <li key={f.text} className={f.level === 'bad' ? 'error' : ''}>
                <LevelBadge level={f.level}>{LEVEL_BADGE[f.level]}</LevelBadge> {f.text}
              </li>
            ))}
          </ul>
          <h3>Protocols</h3>
          <table className="zone-table">
            <thead><tr><th>Version</th><th>Supported</th><th>Cipher</th></tr></thead>
            <tbody>
              {result.protocols.map((p) => (
                <tr key={p.version}>
                  <td>{VERSION_NAMES[p.version]}</td>
                  <td className={p.supported && (p.version === 'TLSv1' || p.version === 'TLSv1.1') ? 'error' : ''}>{p.supported === null ? "Couldn't test" : p.supported ? 'Yes' : 'No'}</td>
                  <td>{p.cipher ? <code>{p.cipher}</code> : <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c && (
            <>
              <h3>Certificate</h3>
              <DetailList
                rows={[
                  ['Subject', c.subject],
                  ['Issuer', c.issuer],
                  ['Trusted', c.trusted ? 'Yes' : `No, ${c.trustError ?? 'unknown reason'}`],
                  ['Valid from', new Date(c.validFrom).toLocaleDateString()],
                  ['Expires', `${new Date(c.validTo).toLocaleDateString()} (${c.daysLeft} days)`],
                  ['Key size', c.keyBits ? `${c.keyBits} bits` : ''],
                  ['Names', c.names.join(', ')],
                  ['HSTS', result.hsts ?? 'None']
                ]}
              />
            </>
          )}
        </>
      )}
      <TestsslScan host={host.trim()} port={Number(port) || 443} />
    </section>
  )
}
