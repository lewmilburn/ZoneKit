import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '@app/shared/errorText'
import { LevelBadge, SettingSingle, SettingText, WarningBox } from '@app/renderer/ui'
import { RESOLVERS, type EmailResult, type ResolverId } from '../shared/ipc'

const LEVEL_BADGE = { bad: 'Problem', warn: 'Warning', good: 'OK' } as const

export function EmailTester(): JSX.Element {
  const [domain, setDomain] = useState('')
  const [resolver, setResolver] = useState<ResolverId>('cloudflare')
  const [result, setResult] = useState<EmailResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await window.zonetester.testEmail({ domain: domain.trim(), resolver })
      if (r.ok) setResult(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const problems = result?.checks.flatMap((c) => c.findings).filter((f) => f.level === 'bad').length ?? 0
  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (domain.trim()) void run()
        }}
      >
        <SettingText label="Domain" placeholder="example.com" value={domain} onChange={setDomain} />
        <SettingSingle<ResolverId>
          label="Resolver"
          options={(Object.keys(RESOLVERS) as ResolverId[]).map((id) => [id, RESOLVERS[id].name] as const)}
          value={resolver}
          onChange={setResolver}
        />
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !domain.trim()}>{busy ? 'Testing...' : 'Test email security'}</button>
        </div>
      </form>
      {error && <WarningBox alert>{error}</WarningBox>}
      {result && (
        <>
          <h3>
            {result.domain} <span className="muted">{problems === 0 ? 'no problems' : `${problems} ${problems === 1 ? 'problem' : 'problems'}`}</span>
          </h3>
          {result.checks.map((c) => (
            <div key={c.name} className="zone-block">
              <h4>{c.name}</h4>
              <ul className="plain-list">
                {c.findings.map((f) => (
                  <li key={f.text} className={f.level === 'bad' ? 'error' : ''}>
                    <LevelBadge level={f.level}>{LEVEL_BADGE[f.level]}</LevelBadge> {f.text}
                  </li>
                ))}
                {c.findings.length === 0 && <li className="muted">None found</li>}
              </ul>
              {c.records.length > 0 && <pre>{c.records.join('\n')}</pre>}
            </div>
          ))}
        </>
      )}
    </section>
  )
}
