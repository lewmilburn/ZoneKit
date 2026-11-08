import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { AuthState } from '../../shared/ipc'
import { REQUIRED_PERMISSIONS } from '../../shared/permissions'
import { SettingRow } from '../components/ui'

interface Props {
  state: AuthState
  onChange: (state: AuthState) => void
}

export function Setup({ state, onChange }: Props): JSX.Element {
  const api = window.zonekeeper
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => ReturnType<typeof api.signOut>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (r.ok) onChange(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault()
    const value = token
    setToken('') // Never keep the token in the page
    await run(() => api.signInWithToken(value))
  }

  const zonePerms = REQUIRED_PERMISSIONS.filter((p) => p.scope === 'Zone')
  const accountPerms = REQUIRED_PERMISSIONS.filter((p) => p.scope === 'Account')

  if (state.signedIn) {
    return (
      <section>
        <SettingRow label="Connected to Cloudflare API" footer={error && <p role="alert" className="error">{error}</p>}>
          <button className="danger" disabled={busy} onClick={() => void run(() => api.signOut())}>Remove API key</button>
        </SettingRow>
      </section>
    )
  }

  return (
    <div className="setup">
      <h2>Set up ZoneKeeper</h2>
      {state.notice && (
        <p role="alert" className="error">
          {state.notice}
        </p>
      )}
      <p>
        ZoneKeeper needs a Cloudflare <strong>API token</strong>, not a Global API Key.
      </p>
      <ol>
        <li>
          <button type="button" onClick={() => void api.openTokenPage()}>
            Open Cloudflare&apos;s API tokens page
          </button>
        </li>
        <li>Choose Create Token, then Create Custom Token.</li>
        <li>
          Grant these permissions (limit the token to the zones and account you want to manage):
          <div className="perm-group">Zone permissions</div>
          <ul className="scopes">
            {zonePerms.map((p) => (
              <li key={p.name}>
                <code>{p.name}</code> <span className="muted">{p.use}</span>
              </li>
            ))}
          </ul>
          <div className="perm-group">Account permissions</div>
          <ul className="scopes">
            {accountPerms.map((p) => (
              <li key={p.name}>
                <code>{p.name}</code> <span className="muted">{p.use}</span>
              </li>
            ))}
          </ul>
        </li>
        <li>Create the token and paste it below.</li>
      </ol>
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor="api-token">API token</label>
        <div className="copy-row">
          <input
            id="api-token"
            type="password"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            spellcheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
          <button type="submit" disabled={busy || !token.trim()}>
            {busy ? 'Checking...' : 'Save token'}
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  )
}
