import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '@app/shared/errorText'
import { ButtonGroup, LevelBadge, WarningBox, type Level } from '@app/renderer/ui'
import type { TestsslResult, TestsslStatus } from '../shared/ipc'
import { explainFinding } from '../shared/testsslNotes'

const ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'WARN', 'INFO', 'OK']
const SEVERITY_LEVEL: Record<string, Level> = { CRITICAL: 'bad', HIGH: 'bad', MEDIUM: 'warn', LOW: 'warn', WARN: 'warn', INFO: 'info', OK: 'good' }
const PROBLEMS = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'WARN'])
/** Sections testssl.sh runs per IP address. */
const SECTIONS_PER_IP = 10

/** One click: downloads testssl.sh the first time, then scans. */
export function TestsslScan({ host, port }: { host: string; port: number }): JSX.Element {
  const [status, setStatus] = useState<TestsslStatus | null>(null)
  const [result, setResult] = useState<TestsslResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'setup' | 'scan'>('idle')
  const [filter, setFilter] = useState('problems')
  const [output, setOutput] = useState<string[]>([])
  const [showOutput, setShowOutput] = useState(false)

  useEffect(() => {
    void window.zonetester.testsslStatus().then((r) => r.ok && setStatus(r.value))
    return window.zonetester.onTestsslOutput((line) => setOutput((o) => [...o.slice(-999), line]))
  }, [])

  async function run(): Promise<void> {
    setError(null)
    setOutput([])
    setPhase(status?.installed ? 'scan' : 'setup')
    try {
      const r = await window.zonetester.runTestssl({ host, port })
      if (r.ok) {
        setResult(r.value)
        setFilter('problems')
      } else setError(r.error)
      setStatus((s) => (s ? { ...s, installed: true } : s))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPhase('idle')
    }
  }

  // testssl prints a " Testing ..." header per section, for each IP it tests
  const ips = /Testing all IP addresses[^:]*:\s*(.+)$/.exec(output.find((l) => /Testing all IP addresses/.test(l)) ?? '')?.[1]?.trim().split(/\s+/).length ?? 1
  const sections = output.filter((l) => /^\s*Testing\s/.test(l) && !/Testing all IP addresses/.test(l))
  const current = sections[sections.length - 1]?.trim()
  const total = Math.max(SECTIONS_PER_IP * ips, sections.length)
  const step = phase === 'idle' || !current ? null : `${current} (step ${sections.length} of about ${total})`
  const label = phase === 'setup' && !current ? 'Setting up...' : phase !== 'idle' ? 'Scanning...' : 'Full scan'

  const findings = result?.findings ?? []
  const multiIp = new Set(findings.map((f) => f.ip).filter(Boolean)).size > 1
  const rank = (s: string): number => (ORDER.indexOf(s) < 0 ? ORDER.length : ORDER.indexOf(s))
  const rows = findings.filter((f) => (filter === 'all' ? true : filter === 'problems' ? PROBLEMS.has(f.severity) : f.severity === filter)).sort((a, b) => rank(a.severity) - rank(b.severity))
  const counts = ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0)
  const problems = findings.filter((f) => PROBLEMS.has(f.severity)).length

  return (
    <section>
      <h3>Full scan</h3>
      <p className="muted">
        Tests every protocol and cipher with testssl.sh
        {status && !status.installed && `, the first scan downloads it (about ${status.downloadMb} MB)`}
      </p>
      <div className="actions">
        <button className="primary" disabled={phase !== 'idle' || !host.trim()} onClick={() => void run()}>{label}</button>
        {step && <span className="muted" role="status">{step}</span>}
        {output.length > 0 && <button onClick={() => setShowOutput((s) => !s)}>{showOutput ? 'Hide output' : 'Show output'}</button>}
      </div>
      {showOutput && <pre className="console">{output.join('\n')}</pre>}
      {error && <WarningBox alert>{error}</WarningBox>}
      {result && (
        <>
          <div className="actions">
            <ButtonGroup<string>
              label="Show"
              options={[['problems', `Problems ${problems}`], ...counts.map(([s, n]) => [s, `${s} ${n}`] as const), ['all', `All ${findings.length}`]]}
              value={filter}
              onChange={setFilter}
            />
            <span className="muted">in {Math.round(result.ms / 1000)}s</span>
          </div>
          {rows.length === 0 && <p className="muted">Nothing here</p>}
          {rows.length > 0 && (
            <div className="table-scroll">
              <table className="zone-table">
                <thead>
                  <tr><th>Severity</th><th>Check</th><th>Finding</th><th>Why</th>{multiIp && <th>IP</th>}</tr>
                </thead>
                <tbody>
                  {rows.map((f, n) => (
                    <tr key={`${f.id}-${f.ip}-${n}`}>
                      <td><LevelBadge level={SEVERITY_LEVEL[f.severity] ?? 'info'}>{f.severity}</LevelBadge></td>
                      <td><code>{f.id}</code></td>
                      <td>{f.finding}{f.cve && <span className="muted"> ({f.cve})</span>}</td>
                      <td className="muted">{explainFinding(f.id, f.finding)}</td>
                      {multiIp && <td className="nowrap"><code>{f.ip}</code></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
