import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import {
  EXPRESSION_FIELDS,
  EXPRESSION_OPERATORS,
  buildExpression,
  parseExpression,
  type ExpressionCondition,
  type ExpressionJoin,
  type ExpressionOperator
} from '../../shared/expressionBuilder'
import { ButtonGroup, SettingRow, SettingText } from './ui'

const NEW_CONDITION: ExpressionCondition = { field: 'http.request.uri.path', operator: 'eq', value: '', join: 'and' }

/** Falls back to text for anything it can't show. */
export function ExpressionBuilder({ value, onChange }: { value: string; onChange: (expression: string) => void }): JSX.Element {
  const [initial] = useState(() => parseExpression(value))
  const [mode, setMode] = useState<'builder' | 'text'>(initial ? 'builder' : 'text')
  const [conditions, setConditions] = useState<ExpressionCondition[]>(initial && initial.length > 0 ? initial : [NEW_CONDITION])
  const [note, setNote] = useState<string | null>(null)

  function update(next: ExpressionCondition[]): void {
    setConditions(next)
    onChange(buildExpression(next))
  }

  const add = (join: ExpressionJoin): void => update([...conditions, { ...NEW_CONDITION, join }])

  function chooseMode(next: 'builder' | 'text'): void {
    setNote(null)
    if (next === 'builder') {
      const parsed = parseExpression(value)
      if (!parsed) {
        setNote('This expression cannot be opened in the builder')
        return
      }
      setConditions(parsed.length > 0 ? parsed : [NEW_CONDITION])
    }
    setMode(next)
  }

  const setAt = (i: number, patch: Partial<ExpressionCondition>): void => update(conditions.map((c, n) => (n === i ? { ...c, ...patch } : c)))

  return (
    <div className="expression-builder">
      <SettingRow label="Expression" {...(note ? { help: note } : {})}>
        <ButtonGroup label="Expression editor" options={[['builder', 'Builder'], ['text', 'Text']] as const} value={mode} onChange={chooseMode} />
      </SettingRow>
      {mode === 'text' && <SettingText label="Expression text" multiline value={value} onChange={onChange} />}
      {mode === 'builder' && (
        <>
          {conditions.map((c, i) => {
            const kind = EXPRESSION_FIELDS.find((f) => f.id === c.field)?.kind ?? 'text'
            const operators = EXPRESSION_OPERATORS.filter((o) => (o.kinds as readonly string[]).includes(kind))
            return (
              <div key={i}>
                {i > 0 && (
                  <ButtonGroup label="Connect to the condition above" options={[['and', 'And'], ['or', 'Or']] as const} value={c.join} onChange={(join) => setAt(i, { join })} />
                )}
                <div className="condition-row">
                <select
                  aria-label="Field"
                  value={c.field}
                  onChange={(e) => {
                    const field = e.currentTarget.value
                    const nextKind = EXPRESSION_FIELDS.find((f) => f.id === field)?.kind ?? 'text'
                    const allowed = EXPRESSION_OPERATORS.find((o) => o.id === c.operator)?.kinds as readonly string[] | undefined
                    setAt(i, { field, ...(allowed?.includes(nextKind) ? {} : { operator: 'eq' as const }) })
                  }}
                >
                  {EXPRESSION_FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
                <select aria-label="Operator" value={c.operator} onChange={(e) => setAt(i, { operator: e.currentTarget.value as ExpressionOperator })}>
                  {operators.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                <input
                  aria-label="Value"
                  spellcheck={false}
                  placeholder={c.operator === 'in' ? 'Separate values with spaces' : 'Value'}
                  value={c.value}
                  onInput={(e) => setAt(i, { value: e.currentTarget.value })}
                />
                <button type="button" disabled={conditions.length === 1} onClick={() => update(conditions.filter((_, n) => n !== i))}>Remove</button>
                </div>
              </div>
            )
          })}
          <div className="actions">
            <button type="button" onClick={() => add('and')}>Add And</button>
            <button type="button" onClick={() => add('or')}>Add Or</button>
          </div>
          {conditions.some((c, i) => i > 0 && c.join === 'or') && conditions.some((c, i) => i > 0 && c.join === 'and') && (
            <p className="muted">And is evaluated before Or, so A or B and C means A or (B and C).</p>
          )}
          <pre>{value || 'Add a value to build the expression.'}</pre>
        </>
      )}
    </div>
  )
}
