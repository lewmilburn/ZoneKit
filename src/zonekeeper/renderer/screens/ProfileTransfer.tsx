import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { plural } from '@app/shared/plural'
import { PROFILE_ITEMS, type ImportSummary } from '../../shared/ipc'
import { errorText } from '../../shared/errorText'
import { SettingRow, WarningBox } from '../components/ui'
import { safe } from './SyncPanel'

function ImportPrompt({ summary, onApply, onCancel }: { summary: ImportSummary; onApply: (replaceIds: string[]) => void; onCancel: () => void }): JSX.Element {
  const [replace, setReplace] = useState<Set<string>>(new Set())
  const toggle = (id: string): void =>
    setReplace((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return (
    <WarningBox>
      <p>{plural(summary.added.length, 'new profile')} will be added.</p>
      {summary.replaced.length > 0 && (
        <>
          <p>Tick the existing profiles to replace.</p>
          {summary.replaced.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={replace.has(p.id)} onChange={() => toggle(p.id)} /> Replace "{p.name}"
            </label>
          ))}
        </>
      )}
      <div className="actions">
        <button className="primary" onClick={() => onApply([...replace])}>Import</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </WarningBox>
  )
}

/** Every profile, with parent links. */
export function ProfileTransfer(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState<ImportSummary | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  async function exportAll(): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const lists = await Promise.all(PROFILE_ITEMS.map((item) => window.zonekeeper.profilesList(item)))
      const failed = lists.find((l) => !l.ok)
      if (failed && !failed.ok) return setNote({ ok: false, text: failed.error })
      const ids = lists.flatMap((l) => (l.ok ? l.value.map((p) => p.id) : []))
      if (ids.length === 0) return setNote({ ok: false, text: 'There are no profiles to export' })
      const r = await window.zonekeeper.exportProfiles(ids)
      if (!r.ok) setNote({ ok: false, text: r.error })
      else if (r.value) setNote({ ok: true, text: `Exported ${plural(ids.length, 'profile')}` })
    } catch (e) {
      setNote({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  async function pick(): Promise<void> {
    setNote(null)
    const r = await safe(window.zonekeeper.importPick())
    if (!r.ok) setNote({ ok: false, text: r.error })
    else if (r.value) setImporting(r.value)
  }

  return (
    <section>
      <SettingRow label="Export profiles" help="Saves every profile to a file.">
        <button disabled={busy} onClick={() => void exportAll()}>Export</button>
      </SettingRow>
      <SettingRow
        label="Import profiles"
        help="Adds profiles from an exported file."
        footer={
          importing && (
            <ImportPrompt
              summary={importing}
              onCancel={() => setImporting(null)}
              onApply={async (replaceIds) => {
                const r = await safe(window.zonekeeper.importApply(importing.importId, replaceIds))
                setImporting(null)
                setNote(r.ok ? { ok: true, text: 'Import finished' } : { ok: false, text: r.error })
              }}
            />
          )
        }
      >
        <button disabled={busy} onClick={() => void pick()}>Import</button>
      </SettingRow>
      {note && <p role={note.ok ? 'status' : 'alert'} className={note.ok ? 'muted' : 'error'}>{note.text}</p>}
    </section>
  )
}
