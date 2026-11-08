import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ProfileDto, ZoneSummary } from '../../shared/ipc'
import type { SecheadSettings } from '../../shared/schemas'
import {
  HEADER_OPTIONS,
  HSTS_AGES,
  HSTS_FLAGS,
  PERMISSION_FEATURES,
  PRESETS,
  SINGLE_CHOICES,
  formatHsts,
  formatPermissions,
  parseHsts,
  parsePermissions,
  presetValues
} from '../../shared/securityHeaders'
import { SettingMultiple, SettingSingle, SettingText, WarningBox } from '../components/ui'
import { ProfilesScreen } from './ProfilesScreen'

/** Empty leaves the header off. */
function HeaderSetting({ name, help, value, onChange }: { name: string; help: string; value: string; onChange: (v: string) => void }): JSX.Element {
  const single = SINGLE_CHOICES[name]
  if (single) return <SettingSingle<string> label={name} help={help} options={[['', 'Off'], ...single]} value={value} onChange={onChange} />
  if (name === 'Strict-Transport-Security') {
    const { age, flags } = parseHsts(value)
    return (
      <>
        <SettingSingle<string> label={name} help={help} options={[['', 'Off'], ...HSTS_AGES]} value={age ?? ''} onChange={(a) => onChange(a === '' ? '' : formatHsts(a, flags))} />
        {age !== null && <SettingMultiple label="HSTS options" options={HSTS_FLAGS} value={flags} onChange={(f) => onChange(formatHsts(age, f))} />}
      </>
    )
  }
  if (name === 'Permissions-Policy') {
    return <SettingMultiple label={name} help={`${help} Choose the features to block.`} options={PERMISSION_FEATURES} value={parsePermissions(value)} onChange={(f) => onChange(formatPermissions(f))} />
  }
  return <SettingText label={name} help={`${help} Leave empty to turn it off.`} multiline value={value} onChange={onChange} />
}

function HeaderFields({ headers, onChange }: { headers: Record<string, string>; onChange: (h: Record<string, string>) => void }): JSX.Element {
  return (
    <>
      <div className="actions">
        <span className="muted">Start from a preset:</span>
        {PRESETS.map((p) => <button key={p.id} type="button" title={p.help} onClick={() => onChange(presetValues(p.id))}>{p.label}</button>)}
      </div>
      {HEADER_OPTIONS.map((h) => (
        <HeaderSetting
          key={h.name}
          name={h.name}
          help={h.help}
          value={headers[h.name] ?? ''}
          onChange={(value) => {
            const next = { ...headers }
            if (value === '') delete next[h.name]
            else next[h.name] = value
            onChange(next)
          }}
        />
      ))}
    </>
  )
}

function ZoneHeaders({ zone }: { zone: ZoneSummary }): JSX.Element {
  const [owners, setOwners] = useState<ProfileDto[] | null>(null)
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.zonekeeper.profilesList('sechead').then((r) => {
      if (r.ok) setOwners(r.value.filter((p) => p.zoneIds.includes(zone.id)))
      else setError(r.error)
    })
    void window.zonekeeper.zoneHeadersGet(zone.id).then((r) => {
      if (r.ok) {
        setHeaders(r.value)
        setSaved(r.value)
      } else setError(r.error)
    })
  }, [zone.id])

  async function save(): Promise<void> {
    setError(null)
    setNotice(null)
    const r = await window.zonekeeper.zoneHeadersSave({ zoneId: zone.id, headers, confirmed: true })
    setConfirming(false)
    if (!r.ok) return setError(r.error)
    setSaved(headers)
    setNotice('Saved.')
  }

  const dirty = JSON.stringify(Object.entries(headers).sort()) !== JSON.stringify(Object.entries(saved).sort())
  if (!owners) return <p role="status">Loading...</p>
  if (owners.length > 0) return <WarningBox>This zone&apos;s headers are managed by {owners.map((o) => o.name).join(', ')}. Edit them on the profile.</WarningBox>
  return (
    <div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <HeaderFields headers={headers} onChange={setHeaders} />
      {!confirming && <div className="actions"><button className="primary" disabled={!dirty} onClick={() => setConfirming(true)}>Save</button></div>}
      {confirming && (
        <WarningBox alert>
          This changes this zone's headers straight away.
          <div className="actions">
            <button className="primary" onClick={() => void save()}>Confirm and save</button>
            <button onClick={() => setConfirming(false)}>Keep editing</button>
          </div>
        </WarningBox>
      )}
    </div>
  )
}

export function SecurityHeaders({ resetSignal, onDirtyChange, initialProfileId }: { resetSignal: number; onDirtyChange: (dirty: boolean) => void; initialProfileId?: string | null }): JSX.Element {
  return (
    <ProfilesScreen
      item="sechead"
      resetSignal={resetSignal}
      onDirtyChange={onDirtyChange}
      initialProfileId={initialProfileId ?? null}
      renderSettings={(settings, onChange) => <HeaderFields headers={(settings as SecheadSettings).headers} onChange={(headers) => onChange({ headers })} />}
      renderZone={(zone) => <ZoneHeaders key={zone.id} zone={zone} />}
    />
  )
}
