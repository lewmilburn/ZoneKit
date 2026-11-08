import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { ProfileRuleList } from '../components/RuleForm'
import { SettingText } from '../components/ui'
import { describeIssues, securitySettingsSchema, type SecuritySettings } from '../../shared/schemas'

/** Text values can use {zone}. */
export function SecurityProfile({ settings, onChange }: { settings: SecuritySettings; onChange: (s: SecuritySettings) => void }): JSX.Element {
  const [text, setText] = useState(JSON.stringify(settings.firewall, null, 2))
  const [error, setError] = useState<string | null>(null)

  function commit(firewall: unknown): void {
    const r = securitySettingsSchema.safeParse({ ...settings, firewall })
    if (!r.success) {
      setError(describeIssues(r.error))
      return
    }
    setError(null)
    setText(JSON.stringify(r.data.firewall, null, 2))
    onChange(r.data)
  }

  function saveJson(): void {
    let firewall: unknown
    try {
      firewall = JSON.parse(text)
    } catch {
      setError('This is not valid JSON.')
      return
    }
    commit(firewall)
  }

  return (
    <section>
      <ProfileRuleList phase="http_request_firewall_custom" rules={settings.firewall} onChange={commit} />
      <details>
        <summary>Advanced: edit as JSON</summary>
        <SettingText label="Rules (JSON)" multiline value={text} onChange={setText} />
        <div className="actions"><button type="button" onClick={saveJson}>Save JSON</button></div>
      </details>
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  )
}
