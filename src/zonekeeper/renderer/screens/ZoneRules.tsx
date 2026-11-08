import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ZoneRulesView, ZoneRuleView, ZoneSummary } from '../../shared/ipc'
import { RULE_SECTION_GROUPS } from '../../shared/ruleSections'
import { ExpressionBuilder } from '../components/ExpressionBuilder'
import { errorText } from '../../shared/errorText'
import { RuleForm } from '../components/RuleForm'
import { ZoneWww } from './ZoneWww'
import { SettingSingle, SettingText, Tabs, WarningBox } from '../components/ui'

function RuleEditor(props: { zoneId: string; phase: string; rule: ZoneRuleView; inProfile: boolean; onSaved: (v: ZoneRulesView) => void; onDirty?: (key: string, dirty: boolean) => void }): JSX.Element {
  const { rule } = props
  const original = {
    description: rule.description,
    expression: rule.expression,
    enabled: rule.enabled,
    params: rule.actionParameters === null ? '' : JSON.stringify(rule.actionParameters, null, 2)
  }
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState(original.description)
  const [expression, setExpression] = useState(original.expression)
  const [enabled, setEnabled] = useState(original.enabled)
  const [params, setParams] = useState(original.params)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await window.zonekeeper.zoneRuleDelete({ zoneId: props.zoneId, phase: props.phase, ruleId: rule.id, fingerprint: rule.fingerprint, confirmed: true })
      if (r.ok) props.onSaved(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
      setDeleting(false)
    }
  }

  const parsed = ((): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } => {
    if (params.trim() === '') return { ok: true, value: undefined }
    try {
      const v: unknown = JSON.parse(params)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: 'Action parameters must be a JSON object.' }
      return { ok: true, value: v as Record<string, unknown> }
    } catch {
      return { ok: false, error: 'Action parameters are not valid JSON.' }
    }
  })()
  const dirty = editing && (description !== original.description || expression !== original.expression || enabled !== original.enabled || params !== original.params)
  const { onDirty } = props
  const dirtyKey = `${rule.id}:${rule.fingerprint}`
  useEffect(() => {
    onDirty?.(dirtyKey, dirty)
    return () => onDirty?.(dirtyKey, false)
  }, [dirty, dirtyKey, onDirty])
  const problem = expression.trim() === '' ? 'The expression can not be empty.' : !parsed.ok ? parsed.error : null

  async function save(): Promise<void> {
    if (!parsed.ok) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.zonekeeper.zoneRuleSave({
        zoneId: props.zoneId,
        phase: props.phase,
        ruleId: rule.id,
        fingerprint: rule.fingerprint,
        description,
        expression,
        enabled,
        ...(parsed.value === undefined ? {} : { actionParameters: parsed.value }),
        confirmed: true
      })
      if (r.ok) props.onSaved(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const rows: Array<[string, string, string]> = [
    ['Description', original.description, description],
    ['Expression', original.expression, expression],
    ['Enabled', String(original.enabled), String(enabled)],
    ['Action parameters', original.params, params]
  ]

  return (
    <li className="rule">
      <strong>{rule.description || '(no description)'}</strong> <span className="muted">{rule.action}</span> {rule.enabled ? 'enabled' : 'disabled'}
      <pre>{rule.expression}</pre>
      <span className="muted">{rule.readOnlyNote ?? (props.inProfile ? 'Not in the profile' : 'Not in a profile')}</span>
      {!rule.readOnlyNote && !editing && !deleting && (
        <span className="actions">
          <button onClick={() => setEditing(true)}>Edit</button>
          <button className="danger" onClick={() => setDeleting(true)}>Delete</button>
        </span>
      )}
      {deleting && (
        <WarningBox alert>
          Delete this rule from the zone?
          <div className="actions">
            <button className="danger" disabled={busy} onClick={() => void remove()}>Yes, delete</button>
            <button disabled={busy} onClick={() => setDeleting(false)}>No</button>
          </div>
        </WarningBox>
      )}
      {editing && !confirming && (
        <div className="rule-form">
          <SettingText label="Description" value={description} onChange={setDescription} />
          <ExpressionBuilder value={expression} onChange={setExpression} />
          <SettingSingle label="Status" options={[['off', 'Disabled'], ['on', 'Enabled']] as const} value={enabled ? 'on' : 'off'} onChange={(v) => setEnabled(v === 'on')} />
          <SettingText label="Action parameters (JSON)" multiline value={params} onChange={setParams} />
          {problem && <p role="alert" className="error">{problem}</p>}
          <div className="actions">
            <button disabled={problem !== null} onClick={() => setConfirming(true)}>Review changes</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {editing && confirming && (
        <div className="rule-form">
          {rows.filter(([, a, b]) => a !== b).map(([label, a, b]) => (
            <div key={label}>
              <strong>{label}</strong>
              <pre>Old: {a || '(none)'}</pre>
              <pre>New: {b || '(none)'}</pre>
            </div>
          ))}
          {rows.every(([, a, b]) => a === b) && <p>No changes.</p>}
          {props.inProfile && <p role="alert">This zone is in a Rules profile: the next sync will flag this rule as a conflict.</p>}
          <div className="actions">
            <button disabled={busy} onClick={() => void save()}>Confirm and save</button>
            <button disabled={busy} onClick={() => setConfirming(false)}>Keep editing</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </li>
  )
}

export function ZoneRules(props: { zone: ZoneSummary; onClose?: () => void; embedded?: boolean; heading?: 'Security' | 'Rules' | 'Cache'; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
  const [view, setView] = useState<ZoneRulesView | null>(null)
  const [tab, setTab] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
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
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async (): Promise<void> => {
    setError(null)
    setView(null)
    try {
      const r = await window.zonekeeper.zoneRulesGet(props.zone.id)
      if (r.ok) setView(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    }
  }, [props.zone.id])
  useEffect(() => {
    void load()
  }, [load])

  const sections = RULE_SECTION_GROUPS.filter((g) => !props.heading || g.heading === props.heading).flatMap((g) => g.items.filter((i) => !i.profileOnly))
  const activeId = tab ?? sections[0]?.id ?? ''
  const current = view?.phases.find((p) => p.phase === activeId)

  return (
    <section className="zone-rules">
      {!props.embedded && <h3>Rules for {props.zone.name}</h3>}
      <div className="actions">
        <button className="btn" onClick={() => void load()}>Reload</button>
        {!props.embedded && props.onClose && <button className="btn" onClick={props.onClose}>Close</button>}
      </div>
      {!view && !error && <p role="status">Loading rules...</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {view && sections.length > 1 && (
        <Tabs
          inline
          tabs={[
            ...sections.map((i) => {
              const n = view.phases.find((x) => x.phase === i.id)?.rules.length ?? 0
              return [i.id, `${i.label} (${n})`] as const
            }),
            ...(props.heading === 'Rules' ? [['www', 'WWW'] as const] : [])
          ]}
          active={activeId}
          onChange={setTab}
        />
      )}
      {activeId === 'www' && <ZoneWww zone={props.zone} />}
      {current && (
        <div>
          {current.status === 'unavailable' && <WarningBox alert>Your token can&apos;t read this</WarningBox>}
          {current.status === 'ok' && (
            <RuleForm
              key={current.phase}
              phase={current.phase}
              busy={adding}
              onAdd={(rule) => {
                setAdding(true)
                setError(null)
                void window.zonekeeper
                  .zoneRuleCreate({ zoneId: props.zone.id, phase: current.phase, rule, confirmed: true })
                  .then((r) => {
                    if (r.ok) setView(r.value)
                    else setError(r.error)
                  })
                  .catch((e: unknown) => setError(errorText(e)))
                  .finally(() => setAdding(false))
              }}
            />
          )}
          {current.status === 'ok' && current.rules.length === 0 && <p className="muted">No rules.</p>}
          <ul>
            {current.rules.map((r) => (
              <RuleEditor key={`${r.id}:${r.fingerprint}`} zoneId={view?.zoneId ?? props.zone.id} phase={current.phase} rule={r} inProfile={view?.profileName !== null} onSaved={setView} onDirty={markDirty} />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
