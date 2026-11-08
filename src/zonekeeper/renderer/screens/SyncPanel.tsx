import { plural } from '@app/shared/plural'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { isConflict } from '../../shared/diff'
import type { ApplyView, IpcResult, PreviewView } from '../../shared/ipc'
import type { Change } from '../../shared/model'
import { errorText } from '../../shared/errorText'
import { WarningBox } from '../components/ui'
import { forgetRuleCounts } from '../components/RuleCounts'
import { driftIdle, pauseDrift } from '../drift'

/** Turns a rejection into an error result. */
export async function safe<T>(p: Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    return await p
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

function entryKey(c: Change): string {
  if (c.type === 'extra') return c.actual.key
  if (c.type === 'different') return c.desired.key
  return c.entry.key
}

function Json({ value }: { value: unknown }): JSX.Element {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>
}

const STATUS_TEXT: Record<string, string> = {
  applied: 'Applied',
  unchanged: 'Already up to date',
  stale: 'Skipped: the zone changed since the preview',
  failed: 'Failed'
}

/** Nothing to change, warn about or answer. */
const upToDate = (z: PreviewView['zones'][number]): boolean =>
  !z.failure && z.warnings.length === 0 && z.unavailable.length === 0 && z.changes.every((c) => c.type === 'unchanged')

export function SyncPanel({ profileId, profileName, onClose }: { profileId: string; profileName: string; onClose: (message?: string) => void }): JSX.Element {
  const [preview, setPreview] = useState<PreviewView | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [overwrites, setOverwrites] = useState<Record<string, string>>({})
  const [pendingAdd, setPendingAdd] = useState<{ key: string; zoneId: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [result, setResult] = useState<ApplyView | null>(null)
  const open = useRef<string | null>(null)
  const started = useRef(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  useEffect(() => window.zonekeeper.onSyncProgress((p) => p.profileId === profileId && setProgress({ done: p.done, total: p.total })), [profileId])
  useEffect(() => {
    if (!busy) setProgress(null)
  }, [busy])
  const working = progress && progress.total > 0 ? `Working... ${progress.done} of ${progress.total}` : 'Working...'

  async function load(fn: () => Promise<IpcResult<PreviewView>>): Promise<void> {
    setBusy(true)
    setError(null)
    setPendingAdd(null)
    setConfirming(false)
    const r = await safe(fn())
    setBusy(false)
    if (r.ok) {
      open.current = r.value.id
      setPreview(r.value)
      setOverwrites({})
    } else {
      open.current = null
      setPreview(null)
      setError(r.profileSaved ? `${r.error} Your profile change is saved.` : r.error)
    }
  }

  const startPreview = (): Promise<void> => load(async () => {
    await driftIdle()
    return window.zonekeeper.syncPreview(profileId)
  })

  // Background checks wait until this sync closes
  useEffect(() => pauseDrift(), [])

  useEffect(() => {
    if (!started.current) {
      started.current = true
      void startPreview()
    }
    // Release the lock on leave
    return () => {
      const id = open.current
      if (id) void window.zonekeeper.syncCancel(id).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function cancelSync(): Promise<void> {
    if (!preview) return onClose()
    const id = preview.id
    open.current = null
    const r = await safe(window.zonekeeper.syncCancel(id))
    if (!r.ok) return setError(r.error)
    onClose(r.value.profileSaved ? 'Sync cancelled, profile changes are kept.' : 'Sync cancelled.')
  }

  async function addAllAndSync(): Promise<void> {
    if (!preview) return
    forgetRuleCounts()
    const id = preview.id
    open.current = null
    setBusy(true)
    setError(null)
    setConfirmingAll(false)
    const added = await safe(window.zonekeeper.syncAddAllToProfile(id))
    if (!added.ok) {
      setBusy(false)
      // Zones disagreeing keeps the preview open
      if (added.profileSaved) setPreview(null)
      else open.current = id
      setError(added.profileSaved ? `${added.error} Your profile change is saved.` : added.error)
      return
    }
    open.current = added.value.id
    // Stop and show problems instead of writing
    if (!added.value.canApply) {
      setBusy(false)
      setPreview(added.value)
      setOverwrites({})
      return
    }
    open.current = null
    const r = await safe(window.zonekeeper.syncApply(added.value.id, added.value.conflicts.map((c) => ({ key: c.key, hash: c.hash }))))
    setBusy(false)
    setPreview(null)
    if (r.ok) setResult(r.value)
    else setError(`${r.error} The profile change is saved.`)
  }

  /** `all` overwrites every conflict. */
  async function apply(all = false): Promise<void> {
    if (!preview) return
    forgetRuleCounts()
    const id = preview.id
    open.current = null
    setBusy(true)
    setError(null)
    const answers = preview.conflicts.map((c) => ({ key: c.key, hash: all ? c.hash : overwrites[c.key] }))
    const r = await safe(window.zonekeeper.syncApply(id, answers))
    setBusy(false)
    setConfirming(false)
    if (r.ok) {
      setResult(r.value)
      setPreview(null)
    } else {
      setPreview(null)
      setError(`${r.error} The preview was discarded and nothing was confirmed as written.`)
    }
  }

  if (result) {
    return (
      <div className="sync">
        <h3>Results for {profileName}</h3>
        <table className="zone-table">
          <thead>
            <tr>
              <th>Zone</th>
              <th>Result</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {result.results.map((z) => (
              <tr key={z.zoneId}>
                <td>{z.zoneName}</td>
                <td className={z.status === 'failed' || z.status === 'stale' ? 'error' : ''}>{STATUS_TEXT[z.status] ?? z.status}</td>
                <td>
                  {z.reason && <div>{z.reason}</div>}
                  {z.status === 'failed' && z.writeAttempted && <div className="error">A write was started, so this zone may be partly changed.</div>}
                  {z.unavailable.length > 0 && (
                    <div className="muted">Skipped, not available for this zone: {z.unavailable.join(', ')}. It may not fully match the profile.</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions">
          <button onClick={() => onClose()}>Done</button>
        </div>
      </div>
    )
  }

  const unanswered = preview ? preview.conflicts.filter((c) => overwrites[c.key] === undefined).length : 0
  const changing = preview ? preview.zones.filter((z) => z.changes.some((c) => c.type !== 'unchanged')).length : 0

  return (
    <div className="sync">
      <h3>Sync {profileName}</h3>
      {error && <p className="error" role="alert">{error}</p>}
      {busy && !preview && <p className="muted" role="status">{working}</p>}
      {!busy && !preview && (
        <div className="actions">
          <button onClick={() => void startPreview()}>Start a new preview</button>
          <button onClick={() => onClose()}>Close</button>
        </div>
      )}
      {preview && (
        <>
          {preview.zones.length === 0 && <p>This profile has no zones.</p>}
          {preview.zones.filter((z) => !upToDate(z)).map((z) => {
            const others = preview.zones.filter((o) => o.zone.id !== z.zone.id)
            return (
              <section key={z.zone.id} className="zone-block">
                <h4>{z.zone.name}</h4>
                {z.failure && <p className="error">This zone could not be read: {z.failure}</p>}
                {z.warnings.map((w) => (
                  <WarningBox key={w}>{w}</WarningBox>
                ))}
                {z.unavailable.length > 0 && (
                  <WarningBox>Skipped, Cloudflare refused access to: {z.unavailable.join(', ')}.</WarningBox>
                )}
                {z.changes
                  .filter((c) => c.type === 'add')
                  .map((c) => (
                    <details key={entryKey(c)}>
                      <summary>Will add: {entryKey(c)}</summary>
                      <Json value={c.type === 'add' ? c.entry.value : null} />
                    </details>
                  ))}
                {z.changes
                  .filter((c) => c.type === 'different' && c.expected)
                  .map((c) => (
                    <details key={entryKey(c)}>
                      <summary>Will change: {entryKey(c)}</summary>
                      <Json value={c.type === 'different' ? c.desired.value : null} />
                    </details>
                  ))}
                {z.changes
                  .filter((c) => c.type === 'extra' && c.owned)
                  .map((c) => (
                    <details key={entryKey(c)}>
                      <summary>Will remove, no longer in the profile: {entryKey(c)}</summary>
                      <Json value={c.type === 'extra' ? c.actual.value : null} />
                    </details>
                  ))}
                {z.changes.filter(isConflict).map((c) => {
                  const key = `${z.zone.id}:${entryKey(c)}`
                  const conflict = preview.conflicts.find((x) => x.key === key)
                  const chosen = overwrites[key] !== undefined
                  return (
                    <WarningBox key={key}>
                      <strong>{c.type === 'extra' ? 'In the zone but not in the profile' : 'Different from the profile'}: {entryKey(c)}</strong>
                      {c.type === 'different' && (
                        <>
                          <div>Profile wants:</div>
                          <Json value={c.desired.value} />
                        </>
                      )}
                      {(c.type === 'different' || c.type === 'extra') && (
                        <>
                          <div>Zone has:</div>
                          <Json value={c.actual.value} />
                        </>
                      )}
                      <div className="actions">
                        <button disabled={busy} onClick={() => void cancelSync()}>Cancel sync</button>
                        <button
                          disabled={busy || !conflict}
                          className={chosen ? 'chosen' : ''}
                          onClick={() => conflict && setOverwrites((o) => ({ ...o, [key]: conflict.hash }))}
                        >
                          Overwrite zone
                        </button>
                        <button disabled={busy} onClick={() => setPendingAdd({ key, zoneId: z.zone.id })}>Overwrite profile</button>
                      </div>
                      {chosen && <p>Answer: Overwrite zone.</p>}
                      {pendingAdd?.key === key && (
                        <WarningBox>
                          <p>
                            This also syncs it to:{' '}
                            {others.length > 0 ? others.map((o) => o.zone.name).join(', ') : 'none, this is the only zone'}.
                          </p>
                          <div className="actions">
                            <button disabled={busy} onClick={() => void load(() => window.zonekeeper.syncAddToProfile(preview.id, key, z.zone.id))}>
                              Yes, add to profile
                            </button>
                            <button onClick={() => setPendingAdd(null)}>Back</button>
                          </div>
                        </WarningBox>
                      )}
                    </WarningBox>
                  )
                })}
              </section>
            )
          })}
          {preview.zones.some(upToDate) && (
            <section className="zone-block">
              <p className="muted">
                {plural(preview.zones.filter(upToDate).length, 'zone')} already up to date
              </p>
            </section>
          )}
          {!preview.canApply && <p className="error">Some zones couldn&apos;t be read, start a new preview.</p>}
          <div className="actions">
            {preview.conflicts.length > 0 && preview.canApply && (
              <>
                <button className="primary" disabled={busy} onClick={() => void apply(true)}>Overwrite all zones</button>
                <button disabled={busy} onClick={() => void addAllAndSync()}>Overwrite profile with all zones</button>
              </>
            )}
            {preview.canApply && unanswered === 0 && changing > 0 && (
              <button className="primary" disabled={busy || confirming} onClick={() => setConfirming(true)}>Apply</button>
            )}
            <button disabled={busy} onClick={async () => {
              const id = preview.id
              open.current = null
              await safe(window.zonekeeper.syncCancel(id))
              void startPreview()
            }}>Preview again</button>
            <button disabled={busy} onClick={() => void cancelSync()}>Close</button>
            {busy && <span className="muted" role="status">{working}</span>}
          </div>
          {confirming && (
            <WarningBox>
              <p>This writes to {plural(changing, 'zone')} in Cloudflare.</p>
              <div className="actions">
                <button disabled={busy} onClick={() => void apply()}>Confirm: write changes</button>
                <button onClick={() => setConfirming(false)}>Back</button>
              </div>
            </WarningBox>
          )}
        </>
      )}
    </div>
  )
}
