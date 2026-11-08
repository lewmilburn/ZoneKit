import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '@app/shared/errorText'
import { SettingMultiple, SettingSingle, SettingText, WarningBox } from '@app/renderer/ui'
import { RESOLVER_IDS, RESOLVERS, SUBDOMAIN_SOURCES, type ResolverId, type SubdomainResult, type SubdomainSource } from '../shared/ipc'

const SOURCE_NAMES: Record<SubdomainSource, string> = { wordlist: 'Common names', records: 'DNS records', certificates: 'Certificates', variations: 'Variations' }

export function SubdomainFinder(): JSX.Element {
  const [domain, setDomain] = useState('')
  const [sources, setSources] = useState<SubdomainSource[]>([...SUBDOMAIN_SOURCES])
  const [resolver, setResolver] = useState<ResolverId>('cloudflare')
  const [result, setResult] = useState<SubdomainResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await window.zonetester.findSubdomains({ domain: domain.trim(), sources, resolver })
      if (r.ok) setResult(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const needle = filter.trim().toLowerCase()
  const shown = (result?.subdomains ?? []).filter((s) => needle === '' || `${s.name} ${s.addresses.join(' ')} ${s.cname ?? ''}`.toLowerCase().includes(needle))

  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (domain.trim() && sources.length > 0) void run()
        }}
      >
        <SettingText label="Domain" placeholder="example.com" value={domain} onChange={setDomain} />
        <SettingMultiple
          label="Sources"
          help="Where to look for names."
          options={SUBDOMAIN_SOURCES.map((s) => [s, SOURCE_NAMES[s]] as const)}
          value={sources}
          onChange={setSources}
        />
        <SettingSingle<ResolverId> label="Resolver" options={RESOLVER_IDS.map((id) => [id, RESOLVERS[id].name] as const)} value={resolver} onChange={setResolver} />
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !domain.trim() || sources.length === 0}>{busy ? 'Searching...' : 'Find subdomains'}</button>
        </div>
      </form>
      {error && <WarningBox alert>{error}</WarningBox>}
      {result && (
        <>
          {result.wildcard && <WarningBox>{result.domain} has wildcard DNS, so guessed names that only match the wildcard are hidden</WarningBox>}
          <h3>
            {result.subdomains.length} found <span className="muted">in {(result.ms / 1000).toFixed(1)}s</span>
          </h3>
          <div className="actions">
            <input aria-label="Filter subdomains" placeholder="Filter" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
          </div>
          <div className="table-scroll">
            <table className="zone-table">
              <thead><tr><th>Name</th><th>Points to</th><th>Found by</th></tr></thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.name}>
                    <td><code>{s.name}</code> {s.wildcard && <span className="badge muted">Wildcard</span>}</td>
                    <td>{s.cname ? <code>{s.cname}</code> : s.addresses.map((a) => <div key={a}><code>{a}</code></div>)}</td>
                    <td>{s.sources.map((src) => <span key={src} className="badge">{SOURCE_NAMES[src]}</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.stale.length > 0 && (
            <details>
              <summary className="muted">{result.stale.length} named but no longer resolving</summary>
              <ul className="plain-list">{result.stale.map((n) => <li key={n}><code>{n}</code></li>)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  )
}
