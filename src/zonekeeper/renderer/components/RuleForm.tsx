import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { ExpressionBuilder } from './ExpressionBuilder'
import { SettingSingle, SettingText } from './ui'

export interface NewRule {
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  enabled: boolean
}

const WAF_ACTIONS = [['block', 'Block'], ['managed_challenge', 'Managed challenge'], ['js_challenge', 'JS challenge'], ['challenge', 'Interactive challenge'], ['log', 'Log']] as const
const STATUSES = [['301', '301 Permanent'], ['302', '302 Temporary'], ['307', '307 Temporary'], ['308', '308 Permanent']] as const
type WafAction = (typeof WAF_ACTIONS)[number][0]
type RedirectStatus = (typeof STATUSES)[number][0]

interface RedirectParams {
  from_value?: { status_code?: number; preserve_query_string?: boolean; target_url?: { value?: string; expression?: string } }
}
type HeaderParams = { headers?: Record<string, { operation?: string; value?: string }> }

const EDGE_TTLS = [['', 'Use origin headers'], ['3600', '1 hour'], ['14400', '4 hours'], ['86400', '1 day'], ['604800', '1 week'], ['2592000', '1 month'], ['31536000', '1 year']] as const
type EdgeTtl = (typeof EDGE_TTLS)[number][0]
type CacheParams = { cache?: boolean; edge_ttl?: { mode?: string; default?: number } }

const isCachePhase = (phase: string): boolean => phase === 'http_request_cache_settings'
const isWafPhase = (phase: string): boolean => phase === 'http_request_firewall_custom'
const isRedirectPhase = (phase: string): boolean => phase === 'http_request_dynamic_redirect'

/** False if editing here would lose anything. */
export function canEditRule(phase: string, rule: Record<string, unknown>): boolean {
  const params = rule.action_parameters as (RedirectParams & HeaderParams) | undefined
  if (isCachePhase(phase)) {
    const p = rule.action_parameters as (CacheParams & Record<string, unknown>) | undefined
    const ttl = p?.edge_ttl
    return (
      rule.action === 'set_cache_settings' &&
      Object.keys(p ?? {}).every((k) => k === 'cache' || k === 'edge_ttl') &&
      (ttl === undefined || (ttl.mode === 'override_origin' && EDGE_TTLS.some(([v]) => v === String(ttl.default))))
    )
  }
  if (isWafPhase(phase)) return WAF_ACTIONS.some(([a]) => a === rule.action) && params === undefined
  if (isRedirectPhase(phase)) return rule.action === 'redirect' && params?.from_value?.target_url !== undefined
  const headers = Object.values(params?.headers ?? {})
  return rule.action === 'rewrite' && headers.length === 1 && (headers[0]?.operation === 'set' || headers[0]?.operation === 'remove') && headers[0]?.value !== undefined === (headers[0]?.operation === 'set')
}

export function RuleForm({ phase, busy, onAdd, initial, onCancel }: { phase: string; busy?: boolean; onAdd: (rule: NewRule) => void; initial?: Record<string, unknown>; onCancel?: () => void }): JSX.Element {
  const params = initial?.action_parameters as (RedirectParams & HeaderParams) | undefined
  const firstHeader = Object.entries(params?.headers ?? {})[0]
  const url = params?.from_value?.target_url
  const targetIsExpression = url?.expression !== undefined

  const [formKey, setFormKey] = useState(0)
  const [description, setDescription] = useState(typeof initial?.description === 'string' ? initial.description : '')
  const [expression, setExpression] = useState(typeof initial?.expression === 'string' ? initial.expression : '')
  const [waf, setWaf] = useState<WafAction>((initial?.action as WafAction | undefined) ?? 'block')
  const [target, setTarget] = useState(url?.expression ?? url?.value ?? '')
  const [status, setStatus] = useState<RedirectStatus>((String(params?.from_value?.status_code ?? 301)) as RedirectStatus)
  const [keepQuery, setKeepQuery] = useState<'on' | 'off'>(params?.from_value?.preserve_query_string === false ? 'off' : 'on')
  const [header, setHeader] = useState(firstHeader?.[0] ?? '')
  const [headerOp, setHeaderOp] = useState<'set' | 'remove'>(firstHeader?.[1].operation === 'remove' ? 'remove' : 'set')
  const [headerValue, setHeaderValue] = useState(firstHeader?.[1].value ?? '')
  const cacheParams = initial?.action_parameters as CacheParams | undefined
  const [cacheOn, setCacheOn] = useState<'on' | 'off'>(cacheParams?.cache === false ? 'off' : 'on')
  const [edgeTtl, setEdgeTtl] = useState<EdgeTtl>((cacheParams?.edge_ttl?.default === undefined ? '' : String(cacheParams.edge_ttl.default)) as EdgeTtl)

  const isWaf = isWafPhase(phase)
  const isRedirect = isRedirectPhase(phase)
  const isCache = isCachePhase(phase)
  const isHeader = !isWaf && !isRedirect && !isCache

  const ready =
    expression.trim() !== '' &&
    (!isRedirect || target.trim() !== '') &&
    (!isHeader || (/^[A-Za-z0-9-]+$/.test(header.trim()) && (headerOp === 'remove' || headerValue.trim() !== '')))

  function submit(): void {
    const base = { ...(description.trim() ? { description: description.trim() } : {}), expression, enabled: initial?.enabled === false ? false : true }
    if (isWaf) onAdd({ ...base, action: waf })
    else if (isCache) {
      onAdd({
        ...base,
        action: 'set_cache_settings',
        action_parameters: cacheOn === 'off' ? { cache: false } : { cache: true, ...(edgeTtl === '' ? {} : { edge_ttl: { mode: 'override_origin', default: Number(edgeTtl) } }) }
      })
    } else if (isRedirect) {
      onAdd({
        ...base,
        action: 'redirect',
        action_parameters: {
          from_value: { status_code: Number(status), target_url: targetIsExpression ? { expression: target.trim() } : { value: target.trim() }, preserve_query_string: keepQuery === 'on' }
        }
      })
    } else {
      onAdd({
        ...base,
        action: 'rewrite',
        action_parameters: { headers: { [header.trim()]: headerOp === 'set' ? { operation: 'set', value: headerValue } : { operation: 'remove' } } }
      })
    }
    if (initial) return
    setDescription('')
    setExpression('')
    setTarget('')
    setHeader('')
    setHeaderValue('')
    setFormKey((k) => k + 1)
  }

  return (
    <fieldset>
      <legend>{initial ? 'Edit rule' : 'Add a rule'}</legend>
      <SettingText label="Description" value={description} onChange={setDescription} />
      <ExpressionBuilder key={formKey} value={expression} onChange={setExpression} />
      {isWaf && <SettingSingle<WafAction> label="Action" options={WAF_ACTIONS} value={waf} onChange={setWaf} />}
      {isCache && (
        <>
          <SettingSingle label="Cache" options={[['on', 'Cache'], ['off', 'Bypass']] as const} value={cacheOn} onChange={setCacheOn} />
          {cacheOn === 'on' && <SettingSingle<EdgeTtl> label="Edge cache TTL" help="How long Cloudflare keeps matching files." options={EDGE_TTLS} value={edgeTtl} onChange={setEdgeTtl} />}
        </>
      )}
      {isRedirect && (
        <>
          <SettingText label="Redirect to" help="In a profile, {zone} becomes each zone's domain." placeholder="https://{zone}/new-path" value={target} onChange={setTarget} />
          <SettingSingle<RedirectStatus> label="Status" options={STATUSES} value={status} onChange={setStatus} />
          <SettingSingle label="Query string" options={[['on', 'Keep'], ['off', 'Remove']] as const} value={keepQuery} onChange={setKeepQuery} />
        </>
      )}
      {isHeader && (
        <>
          <SettingText label="Header name" placeholder="X-Example" value={header} onChange={setHeader} />
          <SettingSingle label="Operation" options={[['set', 'Set'], ['remove', 'Remove']] as const} value={headerOp} onChange={setHeaderOp} />
          {headerOp === 'set' && <SettingText label="Header value" value={headerValue} onChange={setHeaderValue} />}
        </>
      )}
      <div className="actions">
        <button type="button" className="primary" disabled={!ready || busy} onClick={submit}>{initial ? 'Update rule' : 'Add rule'}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </fieldset>
  )
}

type StoredRule = Record<string, unknown>

export function ProfileRuleList({ phase, rules, onChange }: { phase: string; rules: readonly StoredRule[]; onChange: (rules: StoredRule[]) => void }): JSX.Element {
  const [editing, setEditing] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)

  function move(from: number, to: number): void {
    const next = [...rules]
    const [item] = next.splice(from, 1)
    if (item) next.splice(to, 0, item)
    setEditing(null)
    setDeleting(null)
    onChange(next)
  }

  return (
    <>
      {rules.length === 0 && <p className="muted">No rules yet.</p>}
      <ul className="plain-list">
        {rules.map((r, i) => (
          <li key={i} className="rule">
            {editing === i ? (
              <RuleForm
                phase={phase}
                initial={r}
                onCancel={() => setEditing(null)}
                onAdd={(updated) => {
                  // Keeps fields the form doesn't show
                  const { description: _d, ...kept } = r
                  onChange(rules.map((x, n) => (n === i ? { ...kept, ...updated } : x)))
                  setEditing(null)
                }}
              />
            ) : (
              <>
                <div className="rule-title">
                  <strong className="zone-name">{typeof r.description === 'string' && r.description ? r.description : '(no description)'}</strong>
                  <span className="badge">{String(r.action)}</span>
                  {r.enabled === false && <span className="badge">Disabled</span>}
                  <button type="button" disabled={i === 0} aria-label="Move up" onClick={() => move(i, i - 1)}>↑</button>
                  <button type="button" disabled={i === rules.length - 1} aria-label="Move down" onClick={() => move(i, i + 1)}>↓</button>
                  <button type="button" disabled={!canEditRule(phase, r)} title={canEditRule(phase, r) ? undefined : 'This rule can only be edited under Advanced'} onClick={() => setEditing(i)}>Edit</button>
                  {deleting === i ? (
                    <>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          onChange(rules.filter((_, n) => n !== i))
                          setDeleting(null)
                        }}
                      >
                        Yes, delete
                      </button>
                      <button type="button" onClick={() => setDeleting(null)}>No</button>
                    </>
                  ) : (
                    <button type="button" className="danger" onClick={() => setDeleting(i)}>Delete</button>
                  )}
                </div>
                <pre>{String(r.expression)}</pre>
              </>
            )}
          </li>
        ))}
      </ul>
      <RuleForm phase={phase} onAdd={(rule) => onChange([...rules, { ...rule }])} />
    </>
  )
}
