import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { DNS_TYPES, type DnsRecordView, type IpcResult, type ProfileItem, type ZoneSummary } from '../../shared/ipc'
import { errorText } from '../../shared/errorText'
import { SettingSingle, SettingText, Tabs, WarningBox } from '../components/ui'
import { ZoneEmailTab } from './ZoneEmailTab'
import { ZoneDnssec } from './ZoneDnssec'
import { ZoneProfiles } from './ZoneProfiles'

interface Draft {
  type: (typeof DNS_TYPES)[number]
  name: string
  content: string
  ttl: number
  proxied: boolean
  priority: number
}

type DnsTab = 'dns' | 'verifications' | 'pages'
type ZoneTab = 'dns' | 'email' | 'parent' | 'profiles'
const DNS_TABS: ReadonlyArray<readonly [DnsTab, string]> = [['dns', 'General'], ['verifications', 'Verifications'], ['pages', 'Pages Domains']]
const DNSSEC_TAB = 'dnssec'

function dnsTab(r: { type: string; name: string; content: string }): DnsTab {
  const host = r.content.trim().replace(/\.$/, '').toLowerCase()
  if (host.endsWith('.acm-validations.aws')) return 'verifications'
  if (r.type === 'TXT' && `${r.name} ${r.content}`.toLowerCase().includes('verification')) return 'verifications'
  if (host.endsWith('.pages.dev')) return 'pages'
  return 'dns'
}

const PROXIABLE = ['A', 'AAAA', 'CNAME']
const TTLS: ReadonlyArray<[number, string]> = [[1, 'Auto'], [300, '5 min'], [3600, '1 hour'], [86400, '1 day']]
const EMPTY: Draft = { type: 'A', name: '', content: '', ttl: 1, proxied: true, priority: 10 }

function RecordForm(props: { tab: DnsTab; initial: Draft; submitLabel: string; busy: boolean; onSubmit: (d: Draft) => void; onCancel: () => void }): JSX.Element {
  const [d, setD] = useState(props.initial)
  const set = (patch: Partial<Draft>): void => setD((c) => ({ ...c, ...patch }))
  const isVerification = props.tab === 'verifications'
  const suffix = props.tab === 'pages' ? '.pages.dev' : isVerification && d.type !== 'TXT' ? '.acm-validations.aws' : null
  const wrongTarget = props.tab !== 'dns' && d.content.trim() !== '' && dnsTab(d) !== props.tab
  return (
    <div className="rule-form">
      {props.tab === 'dns' && <SettingSingle<Draft['type']> label="Type" options={DNS_TYPES.map((t) => [t, t] as const)} value={d.type} onChange={(type) => set({ type })} />}
      {isVerification && <SettingSingle<Draft['type']> label="Type" options={[['TXT', 'TXT'], ['CNAME', 'CNAME']]} value={d.type} onChange={(type) => set({ type })} />}
      <SettingText label="Name" value={d.name} onChange={(name) => set({ name })} />
      <SettingText
        label={suffix === null ? 'Content' : 'Target'}
        {...(suffix === null ? {} : { placeholder: `example${suffix}` })}
        value={d.content}
        onChange={(content) => set({ content })}
        {...(wrongTarget ? { footer: <p role="alert" className="error">{suffix ? `The target must end in ${suffix}.` : "The name or value must contain 'verification'."}</p> } : {})}
      />
      {d.type === 'MX' && <SettingText label="Priority" type="number" value={String(d.priority)} onChange={(v) => set({ priority: Number(v) })} />}
      <SettingSingle<string> label="TTL" options={TTLS.map(([v, l]) => [String(v), l] as const)} value={String(d.ttl)} onChange={(v) => set({ ttl: Number(v) })} />
      {!isVerification && PROXIABLE.includes(d.type) && (
        <SettingSingle label="Proxy" options={[['off', 'DNS only'], ['on', 'Proxied']] as const} value={d.proxied ? 'on' : 'off'} onChange={(v) => set({ proxied: v === 'on' })} />
      )}
      <WarningBox>Saving changes live DNS straight away.</WarningBox>
      <div className="actions">
        <button className="primary" disabled={props.busy || wrongTarget || d.name.trim() === '' || d.content.trim() === ''} onClick={() => props.onSubmit({ ...d, name: d.name.trim(), content: d.content.trim() })}>{props.submitLabel}</button>
        <button disabled={props.busy} onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export function ZoneDns({ zone, onBack, onOpenProfile, parentPanel }: { zone: ZoneSummary; onBack?: () => void; onOpenProfile: (item: ProfileItem, profileId: string) => void; parentPanel: ComponentChildren }): JSX.Element {
  const [records, setRecords] = useState<DnsRecordView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<ZoneTab>('dns')
  const [dnsView, setDnsView] = useState<DnsTab>('dns')
  const [dnssecOpen, setDnssecOpen] = useState(false)

  const run = useCallback(async (fn: () => Promise<IpcResult<DnsRecordView[]>>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (r.ok) setRecords(r.value)
      else setError(r.error)
      return r.ok
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const load = useCallback(() => run(() => window.zonekeeper.zoneDnsGet(zone.id)), [run, zone.id])
  useEffect(() => {
    void load()
  }, [load])

  const fields = (d: Draft) => ({ type: d.type, name: d.name, content: d.content, ttl: d.ttl, proxied: d.proxied, ...(d.type === 'MX' ? { priority: d.priority } : {}) })
  const needle = filter.toLowerCase()
  const editable = records ?? []
  const inTab = editable.filter((r) => dnsTab(r) === dnsView)
  const shown = inTab.filter((r) => needle === '' || `${r.type} ${r.name} ${r.content}`.toLowerCase().includes(needle))
  const count = (t: DnsTab): number => editable.filter((r) => dnsTab(r) === t).length

  const tabBar = (
    <Tabs<ZoneTab>
      header={{ title: zone.name, ...(onBack ? { onBack } : {}) }}
      tabs={[['dns', 'DNS'], ['email', 'Email'], ['parent', 'Parent zone'], ['profiles', 'Profiles']]}
      {...(tab === 'dns'
        ? {
            subTabs: {
              tabs: [...DNS_TABS.map(([id, label]) => [id, records ? `${label} (${count(id)})` : label] as const), [DNSSEC_TAB, 'DNSSEC'] as const],
              active: dnssecOpen ? DNSSEC_TAB : dnsView,
              onChange: (v: string) => {
                setDnssecOpen(v === DNSSEC_TAB)
                if (v !== DNSSEC_TAB) setDnsView(v as DnsTab)
                setAdding(false)
                setEditing(null)
                setDeleting(null)
              }
            }
          }
        : {})}
      active={tab}
      onChange={(t) => {
        setTab(t)
        setAdding(false)
        setEditing(null)
        setDeleting(null)
      }}
    />
  )

  if (tab === 'email') {
    return (
      <div>
        {tabBar}
        <div><ZoneEmailTab zone={zone} onOpenEmail={(id) => onOpenProfile('email', id)} /></div>
      </div>
    )
  }

  if (tab === 'dns' && dnssecOpen) {
    return (
      <div>
        {tabBar}
        <div><ZoneDnssec zone={zone} /></div>
      </div>
    )
  }

  if (tab === 'profiles') {
    return (
      <div>
        {tabBar}
        <div><ZoneProfiles zone={zone} onOpen={onOpenProfile} /></div>
      </div>
    )
  }

  if (tab === 'parent') {
    return (
      <div>
        {tabBar}
        <div>{parentPanel}</div>
      </div>
    )
  }

  return (
    <div>
      {tabBar}
      <div>
      <div className="actions">
        <input aria-label="Filter DNS records" placeholder="Filter" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
        <button className="primary" onClick={() => setAdding(true)}>Add record</button>
        <button disabled={busy} onClick={() => void load()}>Reload</button>
        <span className="muted" role="status">{busy ? 'Loading...' : records ? `${shown.length} of ${inTab.length}` : ''}</span>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {adding && (
        <div className="rule">
          <RecordForm
            tab={dnsView}
            initial={dnsView === 'verifications' ? { ...EMPTY, type: 'TXT', proxied: false } : dnsView === 'pages' ? { ...EMPTY, type: 'CNAME' } : EMPTY}
            submitLabel="Add record"
            busy={busy}
            onCancel={() => setAdding(false)}
            onSubmit={(d) => void run(() => window.zonekeeper.zoneDnsCreate({ zoneId: zone.id, record: fields(d), confirmed: true })).then((ok) => ok && setAdding(false))}
          />
        </div>
      )}
      {records && inTab.length === 0 && <p className="muted">No records here.</p>}
      <ul className="plain-list">
        {shown.map((r) => (
          <li key={r.id} className="rule">
            <div className="rule-title">
              <span className="badge">{r.type}</span>
              <span className="zone-name">{r.name}</span>
              {r.proxied && <span className="badge">Proxied</span>}
              {editing !== r.id && deleting !== r.id && (
                <>
                  <button onClick={() => setEditing(r.id)}>Edit</button>
                  <button className="danger" onClick={() => setDeleting(r.id)}>Delete</button>
                </>
              )}
            </div>
            <pre>{r.priority !== undefined ? `${r.priority} ` : ''}{r.content}</pre>
            {deleting === r.id && (
              <WarningBox alert>
                Delete this record? This changes live DNS straight away.
                <div className="actions">
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => void run(() => window.zonekeeper.zoneDnsDelete({ zoneId: zone.id, recordId: r.id, fingerprint: r.fingerprint, confirmed: true })).then(() => setDeleting(null))}
                  >
                    Yes, delete
                  </button>
                  <button disabled={busy} onClick={() => setDeleting(null)}>Keep it</button>
                </div>
              </WarningBox>
            )}
            {editing === r.id && (
              <RecordForm
                tab={dnsView}
                initial={{ type: r.type as Draft['type'], name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied, priority: r.priority ?? 10 }}
                submitLabel="Save record"
                busy={busy}
                onCancel={() => setEditing(null)}
                onSubmit={(d) => void run(() => window.zonekeeper.zoneDnsUpdate({ zoneId: zone.id, recordId: r.id, fingerprint: r.fingerprint, record: fields(d), confirmed: true })).then((ok) => ok && setEditing(null))}
              />
            )}
          </li>
        ))}
      </ul>
      </div>
    </div>
  )
}
