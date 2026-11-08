import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { CsamView, ZoneSummary } from '../../shared/ipc'
import { COMPLIANCE_FIELDS } from '../../shared/settingFields'
import { SettingRow, SettingText, WarningBox } from '../components/ui'
import { ProfilesScreen } from './ProfilesScreen'
import { ZoneSettings, type ZoneSettingsApi } from './ZoneSettings'

const API: ZoneSettingsApi = { get: (id) => window.zonekeeper.zoneComplianceGet(id), save: (input) => window.zonekeeper.zoneComplianceSave(input) }
const EMAIL_STATE: Record<string, string> = { valid: 'Confirmed', pending: 'Waiting for you to confirm it', unverified: 'Not confirmed' }

/** Locked until an email is set. */
function ZoneCompliance({ zone }: { zone: ZoneSummary }): JSX.Element {
  const [value, setValue] = useState<CsamView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.zonekeeper
      .zoneCsamGet(zone.id)
      .then((r) => (r.ok ? setValue(r.value) : setError(r.error)))
      .catch((e: unknown) => setError(errorText(e)))
  }, [zone.id])
  const locked = !value ? 'Loading...' : !value.email ? 'Add a notification email below before turning this on' : null
  return (
    <div>
      <ZoneSettings key={value?.email ?? ''} zone={zone} fields={COMPLIANCE_FIELDS} api={API} lockedNote={locked} />
      {error && <p role="alert" className="error">{error}</p>}
      {value && <CsamEmail zone={zone} value={value} onSaved={setValue} />}
    </div>
  )
}

/** Per zone: Cloudflare masks it, so it can't sync. */
function CsamEmail({ zone, value, onSaved }: { zone: ZoneSummary; value: CsamView; onSaved: (v: CsamView) => void }): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await window.zonekeeper.zoneCsamSave({ zoneId: zone.id, email: email.trim(), confirmed: true })
      if (r.ok) {
        onSaved(r.value)
        setEmail('')
      } else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      {error && <p role="alert" className="error">{error}</p>}
      {!value.editable && <WarningBox alert>Cloudflare Trust and Safety has locked the CSAM Scanning Tool for this zone, so it can&apos;t be changed</WarningBox>}
      {value.editable ? (
        <SettingText
          label="Notification email"
          help={
            value.email
              ? `Currently ${value.email} (${(EMAIL_STATE[value.emailState ?? ''] ?? value.emailState ?? 'unknown').toLowerCase()})`
              : 'Where Cloudflare sends match reports.'
          }
          placeholder={`abuse@${zone.name}`}
          value={email}
          onChange={setEmail}
          footer={
            email.trim() !== '' && (
              <div className="actions">
                <button className="primary" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onClick={() => void save()}>Save email</button>
                <button disabled={busy} onClick={() => setEmail('')}>Cancel</button>
              </div>
            )
          }
        />
      ) : (
        <SettingRow label="Notification email">{value.email ? <code>{value.email}</code> : <span className="muted">None set</span>}</SettingRow>
      )}
    </section>
  )
}

export function Compliance(props: { resetSignal: number; onDirtyChange: (dirty: boolean) => void; initialProfileId: string | null }): JSX.Element {
  return (
    <ProfilesScreen
      item="compliance"
      resetSignal={props.resetSignal}
      onDirtyChange={props.onDirtyChange}
      initialProfileId={props.initialProfileId}
      renderZone={(zone) => <ZoneCompliance key={zone.id} zone={zone} />}
    />
  )
}
