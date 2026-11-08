import { useCallback, useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ZoneMailView, ZoneSummary } from '../../shared/ipc'
import { SettingText, WarningBox } from '../components/ui'

type MailRecord = ZoneMailView['records'][number]

function Row(props: { zoneId: string; record: MailRecord; onSaved: (v: ZoneMailView) => void }): JSX.Element {
  const { record } = props
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState(record.content)
  const [priority, setPriority] = useState(String(record.priority))
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function remove(): Promise<void> {
    setError(null)
    const r = await window.zonekeeper.zoneMailDelete({ zoneId: props.zoneId, recordId: record.id, fingerprint: record.fingerprint, confirmed: true })
    setDeleting(false)
    if (r.ok) props.onSaved(r.value)
    else setError(r.error)
  }

  async function save(): Promise<void> {
    setError(null)
    const r = await window.zonekeeper.zoneMailSave({ zoneId: props.zoneId, recordId: record.id, fingerprint: record.fingerprint, content: content.trim(), priority: Number(priority), confirmed: true })
    if (r.ok) props.onSaved(r.value)
    else setError(r.error)
  }

  return (
    <li className="rule">
      <div className="rule-title">
        <span className="badge">{record.priority}</span>
        <span className="zone-name">{record.content}</span>
        {!record.readOnlyNote && !editing && !deleting && (
          <>
            <button onClick={() => setEditing(true)}>Edit</button>
            <button className="danger" onClick={() => setDeleting(true)}>Delete</button>
          </>
        )}
      </div>
      {deleting && (
        <WarningBox alert>
          Delete {record.content} from this zone?
          <div className="actions">
            <button className="danger" onClick={() => void remove()}>Yes, delete</button>
            <button onClick={() => setDeleting(false)}>No</button>
          </div>
        </WarningBox>
      )}
      {record.readOnlyNote && <p className="muted">{record.readOnlyNote}</p>}
      {editing && (
        <div className="rule-form">
          <SettingText label="Mail server" value={content} onChange={setContent} />
          <SettingText label="Priority" type="number" value={priority} onChange={setPriority} />
          <WarningBox alert>Saving changes this zone's mail servers straight away.</WarningBox>
          <div className="actions">
            <button className="primary" onClick={() => void save()}>Confirm and save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </li>
  )
}

export function ZoneMail({ zone }: { zone: ZoneSummary }): JSX.Element {
  const [view, setView] = useState<ZoneMailView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async (): Promise<void> => {
    setError(null)
    const r = await window.zonekeeper.zoneMailGet(zone.id)
    if (r.ok) setView(r.value)
    else setError(r.error)
  }, [zone.id])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <section className="zone-rules">
      <div className="actions"><button onClick={() => void load()}>Reload</button></div>
      {!view && !error && <p role="status">Loading mail servers...</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {view?.records.length === 0 && <p className="muted">This zone has no mail servers.</p>}
      <ul>{view?.records.map((r) => <Row key={`${r.id}:${r.fingerprint}`} zoneId={zone.id} record={r} onSaved={setView} />)}</ul>
    </section>
  )
}
