import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { NotificationPolicy, NotificationsView, ZoneSummary } from '../../shared/ipc'
import { PageHeader, SearchSelect, SettingMultiple, SettingRow, SettingSingle, SettingText, WarningBox, ZoneList, ZoneRow } from '../components/ui'
import { useTopLevelZones } from './Zones'
import { ON_OFF } from '../../shared/settingFields'

type Draft = Omit<NotificationPolicy, 'id'> & { id: string | null }
const EMPTY: Draft = { id: null, name: '', alertType: '', enabled: true, emails: [], zoneIds: [] }
const emailsOf = (text: string): string[] => text.split(/[\s,]+/).map((e) => e.trim()).filter(Boolean)
const validEmail = (e: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

function PolicyForm(props: { account: NotificationsView; zones: ZoneSummary[]; initial: Draft; onDone: (v: NotificationsView | null) => void }): JSX.Element {
  const [d, setD] = useState(props.initial)
  const [emailText, setEmailText] = useState(props.initial.emails.join('\n'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const type = props.account.types.find((t) => t.type === d.alertType)
  const emails = emailsOf(emailText)
  const badEmail = emails.find((e) => !validEmail(e))
  const set = (patch: Partial<Draft>): void => setD((c) => ({ ...c, ...patch }))

  async function run(fn: () => Promise<{ ok: true; value: NotificationsView } | { ok: false; error: string }>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (r.ok) props.onDone(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(() =>
      window.zonekeeper.notificationSave({
        accountId: props.account.accountId,
        ...(d.id ? { policyId: d.id } : {}),
        name: d.name.trim(),
        alertType: d.alertType,
        enabled: d.enabled,
        emails,
        zoneIds: type?.zoneFilter ? d.zoneIds : [],
        confirmed: true
      })
    )

  return (
    <div>
      <PageHeader title={d.id ? d.name || 'Notification' : 'New notification'} onBack={() => props.onDone(null)} />
      {error && <p role="alert" className="error">{error}</p>}
      <SettingText label="Name" value={d.name} onChange={(name) => set({ name })} placeholder="Certificate expiring" />
      <SettingRow label="Alert" help={type?.description || 'What Cloudflare should tell you about.'}>
        <SearchSelect label="Alert" options={props.account.types.map((t) => [t.type, `${t.group}: ${t.name}`] as const)} value={d.alertType} onChange={(alertType) => set({ alertType })} placeholder="Search alerts" />
      </SettingRow>
      <SettingSingle label="Enabled" options={ON_OFF} value={d.enabled ? 'on' : 'off'} onChange={(v) => set({ enabled: v === 'on' })} />
      <SettingText
        label="Send to"
        help="Email addresses, one per line."
        multiline
        value={emailText}
        onChange={setEmailText}
        {...(badEmail ? { footer: <p role="alert" className="error">{badEmail} isn&apos;t a valid email address</p> } : {})}
      />
      {type?.zoneFilter && (
        <SettingMultiple
          label="Zones"
          help="Leave all unselected to cover every zone."
          options={props.zones.map((z) => [z.id, z.name] as const)}
          value={d.zoneIds}
          onChange={(zoneIds) => set({ zoneIds })}
        />
      )}
      <div className="actions">
        <button className="primary" disabled={busy || !d.name.trim() || !d.alertType || emails.length === 0 || Boolean(badEmail)} onClick={() => void save()}>
          {d.id ? 'Save' : 'Create'}
        </button>
        {d.id && !deleting && <button className="danger" disabled={busy} onClick={() => setDeleting(true)}>Delete</button>}
      </div>
      {deleting && d.id && (
        <WarningBox alert>
          Delete this notification? Cloudflare stops sending it straight away.
          <div className="actions">
            <button className="danger" disabled={busy} onClick={() => void run(() => window.zonekeeper.notificationDelete({ accountId: props.account.accountId, policyId: d.id as string, confirmed: true }))}>Yes, delete</button>
            <button disabled={busy} onClick={() => setDeleting(false)}>Keep it</button>
          </div>
        </WarningBox>
      )}
    </div>
  )
}

/** Account-wide, so no profiles. */
export function Notifications(): JSX.Element {
  const zones = useTopLevelZones()
  const [accounts, setAccounts] = useState<NotificationsView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ accountId: string; draft: Draft } | null>(null)

  const load = (): void => {
    setError(null)
    window.zonekeeper
      .notificationsList()
      .then((r) => (r.ok ? setAccounts(r.value) : setError(r.error)))
      .catch((e: unknown) => setError(errorText(e)))
  }
  useEffect(load, [])

  const account = editing && accounts?.find((a) => a.accountId === editing.accountId)
  if (editing && account) {
    return (
      <PolicyForm
        account={account}
        zones={zones}
        initial={editing.draft}
        onDone={(v) => {
          if (v) setAccounts((list) => (list ?? []).map((a) => (a.accountId === v.accountId ? v : a)))
          setEditing(null)
        }}
      />
    )
  }

  const typeName = (a: NotificationsView, t: string): string => a.types.find((x) => x.type === t)?.name ?? t
  const zoneName = (id: string): string => zones.find((z) => z.id === id)?.name ?? id
  return (
    <div>
      <div className="actions">
        <button onClick={load}>Refresh</button>
        {!accounts && !error && <span className="muted" role="status">Loading...</span>}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {accounts?.map((a) => (
        <section key={a.accountId}>
          {accounts.length > 1 && <h3>Account {a.accountId}</h3>}
          <div className="actions">
            <button className="primary" onClick={() => setEditing({ accountId: a.accountId, draft: EMPTY })}>Add notification</button>
          </div>
          {a.policies.length === 0 && <p className="muted">No notifications yet</p>}
          {a.policies.length > 0 && (
            <ZoneList>
              {a.policies.map((p) => (
                <ZoneRow
                  key={p.id}
                  name={p.name}
                  onOpen={() => setEditing({ accountId: a.accountId, draft: p })}
                  meta={
                    <>
                      <span className="badge">{typeName(a, p.alertType)}</span>
                      {!p.enabled && <span className="badge">Off</span>}
                      <span className="muted">{p.emails.join(', ') || 'No email'}</span>
                      {p.zoneIds.length > 0 && <span className="muted">{p.zoneIds.map(zoneName).join(', ')}</span>}
                    </>
                  }
                />
              ))}
            </ZoneList>
          )}
        </section>
      ))}
    </div>
  )
}
