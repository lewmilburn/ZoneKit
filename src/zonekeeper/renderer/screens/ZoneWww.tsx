import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { WwwDirection, ZoneSummary } from '../../shared/ipc'
import { SettingSingle, WarningBox } from '../components/ui'

export function ZoneWww({ zone }: { zone: ZoneSummary }): JSX.Element {
  const [current, setCurrent] = useState<WwwDirection | null>(null)
  const [pending, setPending] = useState<WwwDirection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.zonekeeper.zoneWwwGet(zone.id).then((r) => {
      if (r.ok) setCurrent(r.value)
      else setError(r.error)
    })
  }, [zone.id])

  async function save(): Promise<void> {
    if (!pending) return
    setBusy(true)
    setError(null)
    const r = await window.zonekeeper.zoneWwwSave({ zoneId: zone.id, direction: pending, confirmed: true })
    setBusy(false)
    setPending(null)
    if (r.ok) setCurrent(r.value)
    else setError(r.error)
  }

  if (error && current === null) return <p role="alert" className="error">{error}</p>
  if (current === null) return <p role="status">Loading...</p>
  return (
    <section>
      {error && <p role="alert" className="error">{error}</p>}
      <SettingSingle<WwwDirection>
        label="WWW redirect"
        help="A 301 that keeps the path and query string."
        options={[['off', 'Off'], ['toApex', `www → ${zone.name}`], ['toWww', `${zone.name} → www`]]}
        value={pending ?? current}
        disabled={busy}
        onChange={(v) => setPending(v === current ? null : v)}
        footer={
          pending && (
            <WarningBox alert>
              {pending === 'off'
                ? 'This removes the redirect straight away.'
                : 'This changes the zone straight away, and proxies the source hostname if needed.'}
              <div className="actions">
                <button className="primary" disabled={busy} onClick={() => void save()}>Confirm and save</button>
                <button disabled={busy} onClick={() => setPending(null)}>Cancel</button>
              </div>
            </WarningBox>
          )
        }
      />
    </section>
  )
}
