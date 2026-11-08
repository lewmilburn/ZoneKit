import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { TraceResult, TraceStep } from '../../shared/ipc'
import { SearchSelect, SettingRow, SettingSingle, SettingText } from '../components/ui'
import { countryOptions } from '../countries'

const COUNTRIES: ReadonlyArray<readonly [string, string]> = [['', 'Any'], ...countryOptions()]

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
const METHODS: ReadonlyArray<readonly [Method, string]> = [['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['PATCH', 'PATCH'], ['DELETE', 'DELETE'], ['HEAD', 'HEAD']]

function StepCard({ step }: { step: TraceStep }): JSX.Element {
  return (
    <li className="rule">
      <div className="rule-title">
        <strong className="zone-name">{step.description || '(no description)'}</strong>
        {step.action && <span className="badge">{step.action}</span>}
        {step.phase && <span className="muted">{step.phase}</span>}
      </div>
      <pre>{step.expression}</pre>
    </li>
  )
}

/** Read-only: nothing reaches the origin. */
export function ZoneRuleTest(): JSX.Element {
  const [url, setUrl] = useState('')
  const [method, setMethod] = useState<Method>('GET')
  const [country, setCountry] = useState('')
  const [result, setResult] = useState<TraceResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await window.zonekeeper.zoneTrace({ url: url.trim(), method, ...(country.trim() ? { country: country.trim() } : {}) })
      if (r.ok) setResult(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const matched = result?.steps.filter((s) => s.matched) ?? []
  const unmatched = result?.steps.filter((s) => !s.matched) ?? []

  return (
    <section>
      <SettingText label="URL" help="Any URL on one of your zones." placeholder="https://example.com/path" value={url} onChange={setUrl} />
      <SettingSingle<Method> label="Method" options={METHODS} value={method} onChange={setMethod} />
      <SettingRow label="Visitor's country" help="Optional.">
        <SearchSelect label="Visitor's country" placeholder="Search countries" options={COUNTRIES} value={country} onChange={setCountry} />
      </SettingRow>
      <div className="actions">
        <button className="primary" disabled={busy || url.trim() === ''} onClick={() => void run()}>Test</button>
        <span className="muted" role="status">{busy ? 'Testing...' : ''}</span>
      </div>
      <p className="muted">This tests what&apos;s live on Cloudflare, so it won&apos;t include profile changes you haven&apos;t synced.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {result && (
        <>
          <h3>Rules that would fire on {result.zoneName} ({matched.length})</h3>
          {matched.length === 0 && <p className="muted">No rules match this request.</p>}
          <ul className="plain-list">{matched.map((s, i) => <StepCard key={i} step={s} />)}</ul>
          {result.statusCode !== undefined && <p>Cloudflare would respond with status {result.statusCode}.</p>}
          {unmatched.length > 0 && (
            <details>
              <summary className="muted">Rules that were checked but didn&apos;t match ({unmatched.length})</summary>
              <ul className="plain-list">{unmatched.map((s, i) => <StepCard key={i} step={s} />)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  )
}
