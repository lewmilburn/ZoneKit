import { useCallback, useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { ZoneSummary } from '../../shared/ipc'
import type { SecurityTxt } from '../../shared/schemas'
import { ON_OFF, SECSET_FIELDS } from '../../shared/settingFields'
import { SettingSingle, SettingText, WarningBox } from '../components/ui'
import { SettingsProfile, ZoneSettings, type ZoneSettingsApi } from './ZoneSettings'

type ListField = 'contact' | 'policy' | 'encryption' | 'acknowledgments' | 'canonical' | 'hiring'
const LISTS: ReadonlyArray<readonly [ListField, string, string]> = [
  ['contact', 'Contact', 'Where to report a vulnerability, one per line.'],
  ['policy', 'Policy', 'A link to your disclosure policy.'],
  ['encryption', 'Encryption', 'A link to your public key.'],
  ['acknowledgments', 'Acknowledgments', 'A link to your thanks page.'],
  ['canonical', 'Canonical', 'Where this file is officially hosted.'],
  ['hiring', 'Hiring', 'A link to security jobs.']
]

const oneYearOn = (): string => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)
const API: ZoneSettingsApi = { get: (id) => window.zonekeeper.zoneSecsetGet(id), save: (input) => window.zonekeeper.zoneSecsetSave(input) }

function SecurityTxtFields({ value, onChange, disabled }: { value: SecurityTxt; onChange: (v: SecurityTxt) => void; disabled?: boolean }): JSX.Element {
  const expires = value.expires?.slice(0, 10) ?? ''
  return (
    <fieldset disabled={disabled}>
      <legend>Published file</legend>
      <SettingSingle label="security.txt" help="Published at /.well-known/security.txt." options={ON_OFF} value={value.enabled ? 'on' : 'off'} onChange={(v) => onChange({ ...value, enabled: v === 'on' })} />
      {LISTS.map(([field, label, help]) => (
        <SettingText
          key={`${field}:${(value[field] ?? []).join('|')}`}
          label={label}
          help={help}
          multiline
          value={(value[field] ?? []).join('\n')}
          onCommit={(text) => {
            const list = text.split('\n').map((l) => l.trim()).filter(Boolean)
            const next = { ...value }
            if (list.length > 0) next[field] = list
            else delete next[field]
            onChange(next)
          }}
        />
      ))}
      <SettingText key={`expires:${expires}`} label="Expires" help="Required, under a year away." placeholder={oneYearOn()} value={expires} onCommit={(v) => onChange({ ...value, ...(v.trim() ? { expires: v.trim() } : { expires: '' }) })} />
      <SettingText key={`langs:${value.preferred_languages ?? ''}`} label="Preferred languages" placeholder="en, de" value={value.preferred_languages ?? ''} onCommit={(v) => onChange({ ...value, preferred_languages: v.trim() })} />
    </fieldset>
  )
}

export function SecsetProfile({ settings, onChange, zones }: { settings: Record<string, unknown>; onChange: (s: Record<string, unknown>) => void; zones: ReadonlyArray<{ name: string; plan: string | null }> }): JSX.Element {
  const txt = settings.security_txt as SecurityTxt | undefined
  return (
    <section>
      <SettingsProfile zones={zones} fields={SECSET_FIELDS} settings={settings as Record<string, string | undefined>} onChange={onChange} />
      <h3>security.txt</h3>
      <SettingSingle
        label="Manage security.txt"
        options={[['off', 'Not managed'], ['on', 'Managed']] as const}
        value={txt ? 'on' : 'off'}
        onChange={(v) => {
          const { security_txt: _old, ...rest } = settings
          onChange(v === 'on' ? { ...rest, security_txt: { enabled: true, contact: [], expires: oneYearOn() } } : rest)
        }}
      />
      {txt && <SecurityTxtFields value={txt} onChange={(security_txt) => onChange({ ...settings, security_txt })} />}
    </section>
  )
}

function ZoneSecurityTxt({ zone }: { zone: ZoneSummary }): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [profileName, setProfileName] = useState<string | null>(null)
  const [draft, setDraft] = useState<SecurityTxt>({ enabled: false })
  const [dirty, setDirty] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const apply = useCallback((v: { value: SecurityTxt | null; profileName: string | null }) => {
    setDraft(v.value ?? { enabled: false })
    setProfileName(v.profileName)
    setDirty(false)
    setLoaded(true)
  }, [])

  useEffect(() => {
    window.zonekeeper
      .zoneSecurityTxtGet(zone.id)
      .then((r) => {
        if (r.ok) apply(r.value)
        else setError(r.error)
      })
      .catch((e: unknown) => setError(errorText(e)))
  }, [zone.id, apply])

  async function save(): Promise<void> {
    setError(null)
    setNotice(null)
    setConfirming(false)
    const r = await window.zonekeeper.zoneSecurityTxtSave({ zoneId: zone.id, value: draft, confirmed: true })
    if (!r.ok) return setError(r.error)
    apply(r.value)
    setNotice('Saved.')
  }

  return (
    <section>
      <h3>security.txt</h3>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!loaded && !error && <p role="status">Loading...</p>}
      {profileName && <p className="muted">Managed by profile {profileName}.</p>}
      {loaded && (
        <SecurityTxtFields
          value={draft}
          disabled={profileName !== null}
          onChange={(v) => {
            setDraft(v)
            setDirty(true)
          }}
        />
      )}
      {loaded && !profileName && !confirming && <div className="actions"><button className="primary" disabled={!dirty} onClick={() => setConfirming(true)}>Save</button></div>}
      {confirming && (
        <WarningBox alert>
          This changes the public security.txt on this zone straight away.
          <div className="actions">
            <button className="primary" onClick={() => void save()}>Confirm and save</button>
            <button onClick={() => setConfirming(false)}>Keep editing</button>
          </div>
        </WarningBox>
      )}
    </section>
  )
}

export function ZoneSecset({ zone }: { zone: ZoneSummary }): JSX.Element {
  return (
    <>
      <ZoneSettings zone={zone} fields={SECSET_FIELDS} api={API} />
      <ZoneSecurityTxt zone={zone} />
    </>
  )
}
