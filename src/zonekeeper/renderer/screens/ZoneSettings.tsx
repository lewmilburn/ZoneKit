import { useCallback, useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { IpcResult, ZoneSslView, ZoneSummary } from '../../shared/ipc'
import { planLacks, type SettingField } from '../../shared/settingFields'
import { ButtonGroup, SettingRow, SettingSingle, WarningBox } from '../components/ui'

type Values = Record<string, string | undefined>

const planNote = (f: SettingField): string => `${f.plan === 'enterprise' ? 'Enterprise' : 'Paid'} plan required`

function WithNote({ help, note }: { help: string; note: string | null }): JSX.Element {
  return (
    <>
      {help}
      {note && <span className="help-note">{note}</span>}
    </>
  )
}

/** "Not managed" keeps each zone's value. */
export function SettingsProfile({ fields, settings, onChange, zones }: { fields: readonly SettingField[]; settings: Values; onChange: (s: Values) => void; zones: ReadonlyArray<{ name: string; plan: string | null }> }): JSX.Element {
  // Plan-limited fields show only for zones that have them
  const shown = fields.map((f) => {
    if (!f.plan) return { f, note: null, off: false }
    const ok = zones.filter((z) => !planLacks(f, z.plan))
    const need = planNote(f)
    if (ok.length === 0) return { f, note: need, off: true }
    return { f, note: ok.length === zones.length ? null : `${need}, only applies to ${ok.map((z) => z.name).join(', ')}`, off: false }
  })
  return (
    <section>
      {shown.map(({ f, note, off }) => (
        <SettingSingle<string>
          key={f.id}
          label={f.label}
          help={<WithNote help={f.help} note={note} />}
          disabled={off}
          options={[['', 'Not managed'], ...f.options]}
          value={settings[f.id] ?? ''}
          onChange={(v) => {
            const next = { ...settings }
            if (v === '') delete next[f.id]
            else next[f.id] = v
            onChange(next)
          }}
        />
      ))}
    </section>
  )
}

export interface ZoneSettingsApi {
  get(zoneId: string): Promise<IpcResult<ZoneSslView>>
  save(input: { zoneId: string; field: string; value: string; expected: string; confirmed: true }): Promise<IpcResult<ZoneSslView>>
}

/** Profile-managed settings are read-only. */
export function ZoneSettings({ zone, fields, api, lockedNote }: {
  zone: ZoneSummary
  fields: readonly SettingField[]
  api: ZoneSettingsApi
  /** Disables the buttons, with this as the help. */
  lockedNote?: string | null
}): JSX.Element {
  const [view, setView] = useState<ZoneSslView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ field: string; value: string; expected: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    const r = await api.get(zone.id)
    if (r.ok) setView(r.value)
    else setError(r.error)
  }, [zone.id, api])

  useEffect(() => {
    void load()
  }, [load])

  async function save(): Promise<void> {
    if (!pending) return
    setBusy(true)
    setError(null)
    const r = await api.save({ zoneId: zone.id, ...pending, confirmed: true })
    setBusy(false)
    setPending(null)
    if (r.ok) setView(r.value)
    else setError(r.error)
  }

  return (
    <section>
      <div className="actions"><button onClick={() => void load()}>Reload</button></div>
      {!view && !error && <p role="status">Loading settings...</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {view && fields.map((f) => {
        const live = view.fields.find((x) => x.field === f.id)
        const labelOf = (v: string): string => f.options.find(([o]) => o === v)?.[1] ?? v
        const wanted = live?.profileValue ?? null
        const outOfSync = wanted !== null && live?.value !== null && live?.value !== wanted
        const lacks = planLacks(f, zone.plan)
        const help = (
          <>
            {lockedNote ?? live?.readOnlyNote ?? <WithNote help={f.help} note={lacks ? planNote(f) : null} />}
            {outOfSync && ` This zone is still set to ${labelOf(live?.value as string)} until you sync.`}
          </>
        )
        return (
          <SettingRow
            key={f.id}
            label={f.label}
            help={help}
            footer={
              pending?.field === f.id && (
                <WarningBox alert>
                  This changes {f.label} on this zone straight away.
                  <div className="actions">
                    <button className="primary" disabled={busy} onClick={() => void save()}>Confirm and save</button>
                    <button disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                  </div>
                </WarningBox>
              )
            }
          >
            {wanted === null && (live?.value === null || live?.value === undefined) ? (
              <span className="muted">Not available</span>
            ) : (
              <ButtonGroup
                label={f.label}
                options={f.options}
                value={wanted ?? (pending?.field === f.id ? pending.value : (live?.value as string))}
                disabled={live?.readOnlyNote !== null || busy || Boolean(lockedNote) || lacks}
                onChange={(value: string) => setPending(value === live?.value ? null : { field: f.id, value, expected: live?.value as string })}
              />
            )}
          </SettingRow>
        )
      })}
    </section>
  )
}
