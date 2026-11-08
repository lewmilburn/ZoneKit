import { useState } from 'preact/hooks'
import type { ComponentChildren, JSX } from 'preact'

// Shared components for every page.

/** `alert` announces it to screen readers. */
export function WarningBox({ children, alert }: { children: ComponentChildren; alert?: boolean }): JSX.Element {
  return <div className="warning" {...(alert ? { role: 'alert' } : {})}>{children}</div>
}

/** Pass an array to allow several. */
export function ButtonGroup<T extends string>(props: {
  label: string
  options: ReadonlyArray<readonly [T, string]>
  value: T | null | readonly T[]
  onChange: (value: T) => void
  disabled?: boolean
}): JSX.Element {
  const on = (v: T): boolean => (Array.isArray(props.value) ? props.value.includes(v) : props.value === v)
  return (
    <div className="button-group" role="group" aria-label={props.label}>
      {props.options.map(([v, label]) => (
        <button key={v} type="button" disabled={props.disabled} className={on(v) ? 'chosen' : ''} aria-pressed={on(v)} onClick={() => props.onChange(v)}>{label}</button>
      ))}
    </div>
  )
}

export function SettingRow(props: { label: ComponentChildren; help?: ComponentChildren; children: ComponentChildren; footer?: ComponentChildren }): JSX.Element {
  return (
    <div className="rule">
      <div className="setting-row">
        <div className="setting-text">
          <strong>{props.label}</strong>
          {props.help && <p className="muted">{props.help}</p>}
        </div>
        <div className="setting-control">{props.children}</div>
      </div>
      {props.footer}
    </div>
  )
}

type Options<T extends string> = ReadonlyArray<readonly [T, string]>

export function SettingSingle<T extends string>(props: {
  label: ComponentChildren
  name?: string
  help?: ComponentChildren
  options: Options<T>
  value: T | null
  onChange: (value: T) => void
  disabled?: boolean
  footer?: ComponentChildren
}): JSX.Element {
  return (
    <SettingRow label={props.label} help={props.help} footer={props.footer}>
      <ButtonGroup label={props.name ?? String(props.label)} options={props.options} value={props.value} onChange={props.onChange} {...(props.disabled === undefined ? {} : { disabled: props.disabled })} />
    </SettingRow>
  )
}

export function SettingMultiple<T extends string>(props: {
  label: ComponentChildren
  name?: string
  help?: ComponentChildren
  options: Options<T>
  value: readonly T[]
  onChange: (value: T[]) => void
  disabled?: boolean
}): JSX.Element {
  const toggle = (v: T): void => props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v])
  return (
    <SettingRow label={props.label} help={props.help}>
      <ButtonGroup label={props.name ?? String(props.label)} options={props.options} value={props.value} onChange={toggle} {...(props.disabled === undefined ? {} : { disabled: props.disabled })} />
    </SettingRow>
  )
}

/** `onChange` fires as you type, `onCommit` on blur. */
export function SettingText(props: {
  label: ComponentChildren
  name?: string
  help?: ComponentChildren
  value: string
  onChange?: (value: string) => void
  onCommit?: (value: string) => void
  placeholder?: string
  multiline?: boolean
  type?: 'text' | 'number' | 'password'
  footer?: ComponentChildren
}): JSX.Element {
  const shared = {
    'aria-label': props.name ?? String(props.label),
    spellcheck: false,
    ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
    ...(props.onChange ? { value: props.value, onInput: (e: { currentTarget: { value: string } }) => props.onChange?.(e.currentTarget.value) } : { defaultValue: props.value }),
    ...(props.onCommit ? { onBlur: (e: { currentTarget: { value: string } }) => props.onCommit?.(e.currentTarget.value) } : {})
  }
  return (
    <SettingRow label={props.label} help={props.help} footer={props.footer}>
      {props.multiline ? <textarea className="setting-input" rows={4} {...shared} /> : <input className="setting-input" {...shared} type={(props.type ?? 'text') as 'text'} />}
    </SettingRow>
  )
}

/** For long lists, an empty value means none chosen. */
export function SearchSelect(props: { label: string; options: ReadonlyArray<readonly [string, string]>; value: string; onChange: (value: string) => void; placeholder?: string }): JSX.Element {
  const [query, setQuery] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const selected = props.options.find(([v]) => v === props.value)?.[1] ?? ''
  const open = query !== null
  const needle = (query ?? '').trim().toLowerCase()
  const matches = props.options.filter(([v, l]) => needle === '' || l.toLowerCase().includes(needle) || v.toLowerCase() === needle).slice(0, 50)

  function choose(value: string): void {
    props.onChange(value)
    setQuery(null)
    setHighlight(0)
  }

  return (
    <div className="search-select">
      <input
        className="setting-input"
        role="combobox"
        aria-label={props.label}
        aria-expanded={open}
        spellcheck={false}
        autoComplete="off"
        placeholder={props.placeholder ?? 'Search'}
        value={open ? (query as string) : selected}
        onFocus={() => setQuery('')}
        onBlur={() => setQuery(null)}
        onInput={(e) => {
          setQuery(e.currentTarget.value)
          setHighlight(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlight((h) => Math.min(h + 1, matches.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlight((h) => Math.max(h - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const hit = matches[highlight]
            if (hit) choose(hit[0])
          } else if (e.key === 'Escape') {
            setQuery(null)
          }
        }}
      />
      {open && (
        <ul className="search-options" role="listbox" aria-label={props.label}>
          {matches.length === 0 && <li className="muted">No matches.</li>}
          {matches.map(([v, l], i) => (
            <li key={v} role="option" aria-selected={v === props.value} className={i === highlight ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); choose(v) }}>
              {l}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Panel({ children }: { children: ComponentChildren }): JSX.Element {
  return <div className="panel">{children}</div>
}

/** Use inside ZoneList. */
export type Level = 'good' | 'warn' | 'bad' | 'info'

/** Coloured OK/Warning/Problem pill. */
export function LevelBadge({ level, children }: { level: Level; children: ComponentChildren }): JSX.Element {
  return <span className={`badge level-${level}`}>{children}</span>
}

/** `count` sits last, before the arrow. */
export function ZoneRow(props: { name: ComponentChildren; meta?: ComponentChildren; count?: ComponentChildren; onOpen: () => void }): JSX.Element {
  return (
    <div className="zone-row">
      <button className="zone-link" onClick={props.onOpen}>
        <span className="zone-main">
          <span className="zone-name">{props.name}</span>
          {props.meta && <span className="zone-meta">{props.meta}</span>}
        </span>
        {props.count}
        <span className="chev" aria-hidden="true">›</span>
      </button>
    </div>
  )
}

export function ZoneList({ children }: { children: ComponentChildren }): JSX.Element {
  return <div className="combined-list">{children}</div>
}

/** `header` puts a title above the tabs. */
export function Tabs<T extends string>(props: {
  tabs: ReadonlyArray<readonly [T, string]>
  active: T
  onChange: (tab: T) => void
  header?: { title: ComponentChildren; onBack?: () => void }
  /** Tabs inside page content. */
  inline?: boolean
  /** A second row for the active tab's sections. */
  subTabs?: { tabs: ReadonlyArray<readonly [string, string]>; active: string; onChange: (tab: string) => void }
}): JSX.Element {
  const row = <S extends string>(tabs: ReadonlyArray<readonly [S, string]>, active: S, onChange: (tab: S) => void): JSX.Element => (
    <div className="tab-bar" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={active === id} className={active === id ? 'active' : ''} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  )
  return (
    <div className={props.inline ? 'tabs tabs-inline' : 'tabs'}>
      {props.header && <PageHeader title={props.header.title} {...(props.header.onBack ? { onBack: props.header.onBack } : {})} />}
      {row(props.tabs, props.active, props.onChange)}
      {props.subTabs && row(props.subTabs.tabs, props.subTabs.active, props.subTabs.onChange)}
    </div>
  )
}

/** `actions` replace the back button. */
export function PageHeader({ title, onBack, actions }: { title: ComponentChildren; onBack?: () => void; actions?: ComponentChildren }): JSX.Element {
  return (
    <header className="page-header">
      <h2>{title}</h2>
      {actions ? <div className="actions">{actions}</div> : onBack && <button onClick={onBack}>‹ Back</button>}
    </header>
  )
}

/** Skips empty values. */
export function DetailList({ rows }: { rows: ReadonlyArray<readonly [string, string]> }): JSX.Element {
  return (
    <dl className="detail-list">
      {rows.filter(([, v]) => v).map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}><code>{v}</code></dd>])}
    </dl>
  )
}
