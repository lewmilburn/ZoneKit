import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { DkimRecord, EmailSettings, MailSettings } from '../../shared/schemas'
import { MAIL_PROVIDERS, formatDmarc, parseDmarc, type DmarcPolicy } from '../../shared/mailProviders'
import { SettingSingle, SettingText } from '../components/ui'
import { EmailProfile } from './EmailProfile'
import { ProfilesScreen } from './ProfilesScreen'

/** Microsoft 365 differs per domain, so isn't a preset. */
const PRESETS = MAIL_PROVIDERS.filter((p) => p.mx.length > 0)

/** Unset `mx`: not managed. */
export type MailPart = { mx?: MailSettings['mx']; routes?: MailSettings['routes'] }

function Forwards({ routes, onChange }: { routes: NonNullable<MailSettings['routes']>; onChange: (r: NonNullable<MailSettings['routes']>) => void }): JSX.Element {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const local = from.trim().toLowerCase()
  const valid = /^(\*|[a-z0-9._+-]{1,64})$/.test(local) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())
  return (
    <>
      <ul className="plain-list">
        {routes.map((r) => (
          <li key={r.from} className="rule rule-title">
            <span className="zone-name">{r.from === '*' ? 'Everything else' : `${r.from}@{zone}`}</span>
            <span className="muted">to {r.to}</span>
            <button type="button" className="danger" onClick={() => onChange(routes.filter((x) => x !== r))}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <input aria-label="Address" placeholder="hello, or * for everything" value={from} onInput={(e) => setFrom(e.currentTarget.value)} />
        <input aria-label="Forward to" placeholder="you@example.com" value={to} onInput={(e) => setTo(e.currentTarget.value)} />
        <button
          type="button"
          disabled={!valid}
          onClick={() => {
            onChange([...routes.filter((r) => r.from !== local), { from: local, to: to.trim().toLowerCase() }])
            setFrom('')
            setTo('')
          }}
        >
          Add forward
        </button>
      </div>
      <p className="muted">New addresses get a confirmation email from Cloudflare.</p>
    </>
  )
}

function CustomServers({ mx, onChange }: { mx: MailSettings['mx']; onChange: (mx: MailSettings['mx']) => void }): JSX.Element {
  const [host, setHost] = useState('')
  const [priority, setPriority] = useState('10')
  return (
    <>
      <ul className="plain-list">
        {mx.map((m) => (
          <li key={m.content} className="rule rule-title">
            <span className="badge">{m.priority}</span> <span className="zone-name">{m.content}</span>
            <button type="button" className="danger" onClick={() => onChange(mx.filter((x) => x !== m))}>Remove</button>
          </li>
        ))}
      </ul>
      <SettingText label="Mail server" placeholder="mail.example.com" value={host} onChange={setHost} />
      <SettingText label="Priority" type="number" value={priority} onChange={setPriority} />
      <div className="actions">
        <button
          type="button"
          disabled={host.trim() === '' || priority === ''}
          onClick={() => {
            onChange([...mx, { content: host.trim(), priority: Number(priority) }])
            setHost('')
          }}
        >
          Add server
        </button>
      </div>
    </>
  )
}

export function MailProfile({ settings, onChange }: { settings: MailPart; onChange: (s: MailPart) => void }): JSX.Element {
  const { mx } = settings
  const matched = mx && PRESETS.find((p) => mx.length === p.mx.length && p.mx.every((m) => mx.some((x) => x.content === m.content && x.priority === m.priority)))
  const [custom, setCustom] = useState(mx !== undefined && !matched)
  const choice = mx === undefined ? '' : custom || !matched ? 'custom' : matched.id
  return (
    <section>
      <SettingSingle<string>
        label="Mail provider"
        options={[['', 'Not managed'], ...PRESETS.map((p) => [p.id, p.label] as const), ['custom', 'Custom']]}
        value={choice}
        onChange={(id) => {
          setCustom(id === 'custom')
          if (id === '') onChange({})
          else if (id === 'custom') onChange({ mx: mx ?? [] })
          else onChange({ mx: PRESETS.find((p) => p.id === id)?.mx ?? [], ...(id === 'cloudflare' ? { routes: settings.routes ?? [] } : {}) })
        }}
      />
      {choice === 'cloudflare' && <Forwards routes={settings.routes ?? []} onChange={(routes) => onChange({ ...settings, routes })} />}
      {choice === 'custom' && mx && <CustomServers mx={mx} onChange={(next) => onChange({ mx: next })} />}
    </section>
  )
}

const CLOUDFLARE = MAIL_PROVIDERS.find((p) => p.id === 'cloudflare') as (typeof MAIL_PROVIDERS)[number]
const NO_EMAIL_SPF = 'v=spf1 -all'
const NO_EMAIL_DMARC = 'v=DMARC1; p=reject'

const sameMx = (a: MailSettings['mx'] | undefined, b: MailSettings['mx']): boolean =>
  a !== undefined && a.length === b.length && b.every((m) => a.some((x) => x.content === m.content && x.priority === m.priority))
const presetSpf = (include: string): string => `v=spf1 include:${include} ~all`
const presetDkim = (p: (typeof MAIL_PROVIDERS)[number]): DkimRecord[] => p.dkim.map((d) => ({ selector: d.selector, type: 'CNAME', mode: 'shared', value: d.target }))
const sameDkim = (a: DkimRecord[], b: DkimRecord[]): boolean => a.length === b.length && b.every((r) => a.some((x) => x.selector === r.selector && x.value === r.value))

/** What a dashboard-style choice would set, `null` for custom. */
function detect(s: EmailSettings): string | null {
  if (s.mx === undefined && s.spf === null && s.dmarc === null && s.dkim.length === 0 && !s.tlsRpt && !s.bimi) return 'off'
  if (sameMx(s.mx, CLOUDFLARE.mx) && s.spf === null && s.dkim.length === 0) return 'cloudflare'
  if (s.mx?.length === 0 && s.spf === NO_EMAIL_SPF && s.dmarc === NO_EMAIL_DMARC && s.dkim.length === 0) return 'none'
  const p = PRESETS.find((x) => x.id !== 'cloudflare' && sameMx(s.mx, x.mx) && s.spf === presetSpf(x.spfInclude) && sameDkim(s.dkim, presetDkim(x)))
  return p?.id ?? null
}

function settingsFor(setup: string, current: EmailSettings): EmailSettings {
  const dmarc = current.dmarc !== null && current.dmarcType !== 'CNAME' && current.dmarc !== NO_EMAIL_DMARC ? current.dmarc : 'v=DMARC1; p=none'
  if (setup === 'off') return { spf: null, dmarc: null, dkim: [] }
  if (setup === 'none') return { spf: NO_EMAIL_SPF, dmarc: NO_EMAIL_DMARC, dkim: [], mx: [] }
  // Kept across provider changes
  const extras = {
    ...(current.tlsRpt === undefined ? {} : { tlsRpt: current.tlsRpt }),
    ...(current.bimi === undefined ? {} : { bimi: current.bimi }),
    ...(current.dmarcReports === undefined ? {} : { dmarcReports: current.dmarcReports })
  }
  // Email Routing adds its own SPF and DKIM
  if (setup === 'cloudflare') return { spf: null, dmarc, dkim: [], mx: CLOUDFLARE.mx, routes: current.routes ?? [], ...extras }
  const p = PRESETS.find((x) => x.id === setup)
  if (!p) return current
  return { spf: presetSpf(p.spfInclude), dmarc, dkim: presetDkim(p), mx: p.mx, ...extras }
}

function SimpleDmarc({ settings, onChange }: { settings: EmailSettings; onChange: (s: EmailSettings) => void }): JSX.Element {
  const tags = parseDmarc(settings.dmarc ?? 'v=DMARC1; p=none')
  const set = (tag: string, value: string): void => {
    const next = new Map(tags)
    if (value === '') next.delete(tag)
    else next.set(tag, value)
    onChange({ ...settings, dmarc: formatDmarc(next) })
  }
  const reportTo = tags.get('rua')?.replace(/^mailto:/, '') ?? ''
  const [ownAddress, setOwnAddress] = useState(reportTo !== '')
  const reports = settings.dmarcReports === 'cloudflare' ? 'cloudflare' : ownAddress || reportTo !== '' ? 'email' : 'none'
  return (
    <>
      <SettingSingle<DmarcPolicy>
        label="Mail that fails checks"
        options={[['none', 'Monitor only'], ['quarantine', 'Send to spam'], ['reject', 'Block']]}
        value={(tags.get('p') as DmarcPolicy | undefined) ?? 'none'}
        onChange={(p) => set('p', p)}
      />
      <SettingSingle<string>
        label="DMARC reports"
        options={[['cloudflare', 'Cloudflare'], ['email', 'An email address'], ['none', 'None']]}
        value={reports}
        onChange={(v) => {
          setOwnAddress(v === 'email')
          const next = new Map(tags)
          if (v !== 'email') next.delete('rua')
          const { dmarcReports: _old, ...rest } = settings
          onChange({ ...rest, dmarc: formatDmarc(next), ...(v === 'cloudflare' ? { dmarcReports: 'cloudflare' as const } : {}) })
        }}
      />
      {reports === 'email' && (
        <SettingText label="Send reports to" placeholder="dmarc@example.com" key={`rua:${reportTo}`} value={reportTo} onCommit={(v) => set('rua', v.trim() === '' ? '' : `mailto:${v.trim()}`)} />
      )}
    </>
  )
}

/** TLS-RPT and BIMI, each a single TXT record. */
function EmailExtras({ settings, onChange }: { settings: EmailSettings; onChange: (s: EmailSettings) => void }): JSX.Element {
  const set = <K extends 'tlsRpt' | 'bimi'>(key: K, value: EmailSettings[K] | undefined): void => {
    const { [key]: _old, ...rest } = settings
    onChange(value === undefined ? (rest as EmailSettings) : { ...settings, [key]: value })
  }
  const bimi = settings.bimi
  return (
    <>
      <SettingText
        label="TLS failure reports to"
        placeholder="tls-reports@example.com"
        key={`tlsrpt:${settings.tlsRpt ?? ''}`}
        value={settings.tlsRpt ?? ''}
        onCommit={(v) => set('tlsRpt', v.trim() === '' ? undefined : v.trim().toLowerCase())}
      />
      <SettingText
        label="BIMI logo"
        help="An https link to a square SVG, shown next to your mail in supporting inboxes."
        placeholder="https://example.com/logo.svg"
        key={`bimi:${bimi?.logo ?? ''}`}
        value={bimi?.logo ?? ''}
        onCommit={(v) => set('bimi', v.trim() === '' ? undefined : { ...bimi, logo: v.trim() })}
      />
      {bimi && (
        <SettingText
          label="Verified Mark Certificate"
          help="Gmail and Apple Mail need one to show the logo."
          placeholder="https://example.com/vmc.pem"
          key={`vmc:${bimi.vmc ?? ''}`}
          value={bimi.vmc ?? ''}
          onCommit={(v) => set('bimi', v.trim() === '' ? { logo: bimi.logo } : { logo: bimi.logo, vmc: v.trim() })}
        />
      )}
    </>
  )
}

/** One choice sets mail servers, SPF, DKIM and DMARC, like the Cloudflare dashboard. */
export function EmailSetup({ settings, zones, onChange }: { settings: EmailSettings; zones: Array<{ id: string; name: string }>; onChange: (s: EmailSettings) => void }): JSX.Element {
  const detected = detect(settings)
  const [custom, setCustom] = useState(detected === null)
  const choice = custom || detected === null ? 'custom' : detected
  const { mx, routes, ...security } = settings
  return (
    <section>
      <SettingSingle<string>
        label="Email setup"
        options={[['off', 'Not managed'], ['cloudflare', CLOUDFLARE.label], ...PRESETS.filter((p) => p.id !== 'cloudflare').map((p) => [p.id, p.label] as const), ['none', "Doesn't send email"], ['custom', 'Custom']]}
        value={choice}
        onChange={(id) => {
          setCustom(id === 'custom')
          if (id !== 'custom') onChange(settingsFor(id, settings))
        }}
      />
      {choice === 'cloudflare' && <Forwards routes={routes ?? []} onChange={(r) => onChange({ ...settings, routes: r })} />}
      {choice === 'none' && <p className="muted">Blocks anyone sending email as this domain.</p>}
      {choice !== 'off' && choice !== 'none' && choice !== 'custom' && <SimpleDmarc settings={settings} onChange={onChange} />}
      {choice !== 'off' && choice !== 'none' && <EmailExtras settings={settings} onChange={onChange} />}
      {choice === 'custom' && (
        <>
          <MailProfile settings={{ ...(mx === undefined ? {} : { mx }), ...(routes === undefined ? {} : { routes }) }} onChange={(m) => onChange({ ...security, ...m } as EmailSettings)} />
          <EmailProfile settings={security as EmailSettings} zones={zones} onChange={(s) => onChange({ ...s, ...(mx === undefined ? {} : { mx }), ...(routes === undefined ? {} : { routes }) })} />
        </>
      )}
    </section>
  )
}

/** Mail servers and email security share one profile. */
export function EmailScreen(props: { resetSignal: number; onDirtyChange: (dirty: boolean) => void; initialProfileId: string | null }): JSX.Element {
  return <ProfilesScreen item="email" resetSignal={props.resetSignal} onDirtyChange={props.onDirtyChange} initialProfileId={props.initialProfileId} />
}
