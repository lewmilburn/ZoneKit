import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ZoneEmailRecordView, ZoneEmailView, ZoneSummary } from '../../shared/ipc'
import { errorText } from '../../shared/errorText'
import { SettingText, WarningBox } from '../components/ui'

const AREA_LABELS = { spf: 'SPF', dmarc: 'DMARC', dkim: 'DKIM', tlsrpt: 'TLS reporting (TLS-RPT)', bimi: 'BIMI' } as const

function RecordEditor(props: { zoneId: string; record: ZoneEmailRecordView; inProfile: boolean; onSaved: (v: ZoneEmailView) => void; onDirty: (key: string, dirty: boolean) => void }): JSX.Element {
  const { record, onDirty } = props
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [content, setContent] = useState(record.content)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dirty = editing && content !== record.content
  const key = `${record.id}:${record.fingerprint}`

  useEffect(() => {
    onDirty(key, dirty)
    return () => onDirty(key, false)
  }, [dirty, key, onDirty])

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await window.zonekeeper.zoneEmailSave({ zoneId: props.zoneId, recordId: record.id, fingerprint: record.fingerprint, content, confirmed: true })
      if (r.ok) props.onSaved(r.value)
      else {
        setError(r.error)
        setConfirming(false)
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rule">
      <div className="rule-title">
        <strong>{record.name}</strong>
        <span className="badge">{record.type}</span>
      </div>
      <pre>{record.content}</pre>
      {record.readOnlyNote && <p className="muted">{record.readOnlyNote}</p>}
      {!record.readOnlyNote && !editing && <button onClick={() => setEditing(true)}>Edit</button>}
      {editing && !confirming && (
        <div className="rule-form">
          <SettingText label={record.type === 'CNAME' ? 'Target' : 'Value'} multiline value={content} onChange={setContent} />
          <div className="actions">
            <button className="primary" disabled={!dirty || content.trim() === ''} onClick={() => setConfirming(true)}>Review changes</button>
            <button
              onClick={() => {
                setContent(record.content)
                setEditing(false)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {editing && confirming && (
        <div className="rule-form">
          <strong>Old</strong>
          <pre>{record.content}</pre>
          <strong>New</strong>
          <pre>{content}</pre>
          <WarningBox alert>
            A mistake here can break email for this domain.
            {props.inProfile && ' This zone is in an Email profile, so the next sync will flag this record as a conflict.'}
          </WarningBox>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => void save()}>Confirm and save</button>
            <button disabled={busy} onClick={() => setConfirming(false)}>Keep editing</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </li>
  )
}

export function ZoneEmail(props: { zone: ZoneSummary; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
  const [view, setView] = useState<ZoneEmailView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirtySet = useRef<Set<string>>(new Set())
  const { onDirtyChange } = props

  const markDirty = useCallback(
    (key: string, dirty: boolean): void => {
      if (dirty) dirtySet.current.add(key)
      else dirtySet.current.delete(key)
      onDirtyChange?.(dirtySet.current.size > 0)
    },
    [onDirtyChange]
  )

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    setView(null)
    try {
      const r = await window.zonekeeper.zoneEmailGet(props.zone.id)
      if (r.ok) setView(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    }
  }, [props.zone.id])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="zone-rules">
      <div className="actions">
        <button onClick={() => void load()}>Reload</button>
      </div>
      {!view && !error && <p role="status">Loading email records...</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {view?.warnings.map((w) => <WarningBox key={w}>{w}</WarningBox>)}
      {view?.areas.map((a) => (
        <div key={a.area} className="rule-section">
          <h4>{AREA_LABELS[a.area]}</h4>
          {a.status === 'unavailable' && <WarningBox alert>Your token can&apos;t read this</WarningBox>}
          {a.status === 'ok' && a.records.length === 0 && <p className="muted">None found.</p>}
          <ul>
            {a.records.map((r) => (
              <RecordEditor key={`${r.id}:${r.fingerprint}`} zoneId={view.zoneId} record={r} inProfile={view.profileName !== null} onSaved={setView} onDirty={markDirty} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
