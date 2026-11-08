import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { ParentLinks, ParentPreview, ZoneSummary } from '../../shared/ipc'
import { Panel, SearchSelect, SettingRow, WarningBox, ZoneList, ZoneRow } from '../components/ui'

export function ZoneParent(props: { zone: ZoneSummary; zones: ZoneSummary[]; links: ParentLinks; onChange: (links: ParentLinks) => void; onOpenZone: (zone: ZoneSummary) => void }): JSX.Element {
  const { zone, zones, links } = props
  const [parentId, setParentId] = useState('')
  const [preview, setPreview] = useState<ParentPreview | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const currentParent = zones.find((z) => z.id === links[zone.id])
  const children = zones.filter((z) => links[z.id] === zone.id)
  const parents = zones.filter((z) => z.id !== zone.id && !links[z.id])

  async function run<T>(fn: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>, done: (v: T) => void): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (r.ok) done(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const apply = (overwrite: boolean): void => {
    if (!preview) return
    void run(
      () => window.zonekeeper.parentApply({ childId: preview.childId, parentId: preview.parentId, fingerprint: preview.fingerprint, overwrite }),
      (l) => {
        setPreview(null)
        props.onChange(l)
      }
    )
  }

  return (
    <section>
      {error && <p role="alert" className="error">{error}</p>}
      {children.length > 0 && (
        <>
          <h4>Child zones</h4>
          <ZoneList>
            {children.map((c) => <ZoneRow key={c.id} name={c.name} onOpen={() => props.onOpenZone(c)} />)}
          </ZoneList>
        </>
      )}
      {currentParent && (
        <>
          <p>All traffic to this zone redirects to <strong>{currentParent.name}</strong>.</p>
          {!confirmRemove && <button onClick={() => setConfirmRemove(true)}>Remove parent</button>}
          {confirmRemove && (
            <WarningBox alert>
              This deletes the redirect rule, so this zone stops redirecting.
              <div className="actions">
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.zonekeeper.parentRemove({ childId: zone.id, confirmed: true }), (l) => {
                      setConfirmRemove(false)
                      props.onChange(l)
                    })
                  }
                >
                  Remove parent and redirect
                </button>
                <button disabled={busy} onClick={() => setConfirmRemove(false)}>Keep it</button>
              </div>
            </WarningBox>
          )}
        </>
      )}
      {!currentParent && children.length === 0 && !preview && (
        <>
          <SettingRow label="Redirect all traffic to">
            <SearchSelect label="Parent zone" placeholder="Search zones" options={parents.map((z) => [z.id, z.name] as const)} value={parentId} onChange={setParentId} />
          </SettingRow>
          <div className="actions">
            <button disabled={busy || parentId === ''} onClick={() => void run(() => window.zonekeeper.parentPreview({ childId: zone.id, parentId }), setPreview)}>Preview</button>
          </div>
        </>
      )}
      {preview && (
        <Panel>
          <p>A 301 rule will send all traffic from <strong>{preview.childName}</strong> to <strong>{preview.parentName}</strong>, keeping the path and query string.</p>
          {preview.dnsChange && <p>{preview.dnsChange}</p>}
          {preview.warnings.map((w) => <WarningBox key={w}>{w}</WarningBox>)}
          {preview.conflicts.length > 0 && (
            <>
              <p><strong>Conflict:</strong> Overwrite permanently removes these existing redirect rules from this zone:</p>
              {preview.conflicts.map((c, i) => (
                <div key={i}><strong>{c.description || '(no description)'}</strong><pre>{c.expression}</pre></div>
              ))}
            </>
          )}
          <div className="actions">
            {preview.conflicts.length === 0 ? (
              <button className="primary" disabled={busy} onClick={() => apply(false)}>Apply</button>
            ) : (
              <button className="danger" disabled={busy} onClick={() => apply(true)}>Overwrite</button>
            )}
            <button disabled={busy} onClick={() => setPreview(null)}>Cancel sync</button>
          </div>
        </Panel>
      )}
    </section>
  )
}
