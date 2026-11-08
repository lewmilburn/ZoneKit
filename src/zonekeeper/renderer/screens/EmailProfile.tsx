import { useState } from 'preact/hooks'
import { SettingMultiple, SettingSingle, SettingText } from '../components/ui'
import { MAIL_PROVIDERS, dkimSelector, formatDmarc, formatSpf, parseDmarc, parseSpf, type DmarcPolicy, type SpfAll } from '../../shared/mailProviders'
import { describeIssues, emailSettingsSchema, type DkimRecord, type EmailSettings } from '../../shared/schemas'

export interface EmailProfileProps {
  settings: EmailSettings
  /** For per-zone DKIM values. */
  zones: Array<{ id: string; name: string }>
  onChange: (settings: EmailSettings) => void
}

const EMPTY_DRAFT = { selector: '', type: 'TXT' as DkimRecord['type'], mode: 'shared' as DkimRecord['mode'], value: '' }
const MANAGE = [['off', 'Not managed'], ['on', 'Managed']] as const
const DEFAULT_SPF = 'v=spf1 ~all'
const DEFAULT_DMARC = 'v=DMARC1; p=none'

export function EmailProfile({ settings, zones, onChange }: EmailProfileProps) {
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [error, setError] = useState<string | null>(null)

  function commit(next: unknown): boolean {
    const r = emailSettingsSchema.safeParse(next)
    if (!r.success) {
      setError(describeIssues(r.error))
      return false
    }
    setError(null)
    onChange(r.data)
    return true
  }

  const spf = settings.spf === null ? null : parseSpf(settings.spf)
  const setSpf = (patch: Partial<NonNullable<typeof spf>>): void => {
    if (spf) commit({ ...settings, spf: formatSpf({ ...spf, ...patch }) })
  }

  /** Also adds or removes the provider's DKIM records. */
  function setProviders(includes: string[]): void {
    if (!spf) return
    const known = MAIL_PROVIDERS.map((p) => p.spfInclude)
    const kept = spf.includes.filter((i) => !known.includes(i))
    const on = MAIL_PROVIDERS.filter((p) => includes.includes(p.spfInclude))
    const off = MAIL_PROVIDERS.filter((p) => !includes.includes(p.spfInclude))
    const removed = new Set(off.flatMap((p) => p.dkim.map((d) => d.selector)))
    const added: DkimRecord[] = on.flatMap((p) => p.dkim.map((d): DkimRecord => ({ selector: d.selector, type: 'CNAME', mode: 'shared', value: d.target })))
    const dkim = [...settings.dkim.filter((r) => !removed.has(r.selector) && !added.some((a) => a.selector === r.selector)), ...added]
    commit({ ...settings, spf: formatSpf({ ...spf, includes: [...on.map((p) => p.spfInclude), ...kept] }), dkim })
  }

  const dmarcCname = settings.dmarcType === 'CNAME'
  const dmarcTags = settings.dmarc !== null && !dmarcCname ? parseDmarc(settings.dmarc) : null
  function setDmarcTag(tag: string, value: string): void {
    if (!dmarcTags) return
    const next = new Map(dmarcTags)
    if (value === '') next.delete(tag)
    else next.set(tag, value)
    commit({ ...settings, dmarc: formatDmarc(next) })
  }
  function setDmarcKind(kind: 'TXT' | 'CNAME'): void {
    const { dmarcType: _old, ...rest } = settings
    commit(kind === 'CNAME' ? { ...rest, dmarc: 'dmarcroot.example.com', dmarcType: 'CNAME' } : { ...rest, dmarc: DEFAULT_DMARC })
  }
  const reportTo = dmarcTags?.get('rua')?.replace(/^mailto:/, '') ?? ''

  function updateRecord(i: number, record: DkimRecord | null): void {
    const dkim = settings.dkim.flatMap((r, n) => (n !== i ? [r] : record ? [record] : []))
    commit({ ...settings, dkim })
  }

  function addRecord(): void {
    const record: DkimRecord =
      draft.mode === 'shared'
        ? { selector: dkimSelector(draft.selector), type: draft.type, mode: 'shared', value: draft.value }
        : { selector: dkimSelector(draft.selector), type: draft.type, mode: 'perZone', perZone: {} }
    if (commit({ ...settings, dkim: [...settings.dkim, record] })) setDraft(EMPTY_DRAFT)
  }

  function setZoneValue(i: number, zoneId: string, value: string): void {
    const r = settings.dkim[i]
    const { [zoneId]: _removed, ...rest } = r.perZone ?? {}
    updateRecord(i, { ...r, perZone: value === '' ? rest : { ...rest, [zoneId]: value } })
  }

  const knownIncludes = MAIL_PROVIDERS.map((p) => p.spfInclude)

  return (
    <section>
      <fieldset>
        <legend>SPF</legend>
        <SettingSingle label="SPF" name="Manage SPF" options={MANAGE} value={spf ? 'on' : 'off'} onChange={(v) => commit({ ...settings, spf: v === 'on' ? DEFAULT_SPF : null })} />
        {spf && (
          <>
            <SettingMultiple<string>
              label="Mail providers"
              help="Servers allowed to send your mail."
              options={MAIL_PROVIDERS.map((p) => [p.spfInclude, p.label] as const)}
              value={spf.includes.filter((i) => knownIncludes.includes(i))}
              onChange={setProviders}
            />
            <SettingMultiple<string> label="This domain's own servers" options={[['a', 'Web server (a)'], ['mx', 'Mail servers (mx)']]} value={spf.own} onChange={(own) => setSpf({ own })} />
            <SettingText
              label="Other senders"
              help="For a provider not listed, such as include:_spf.example.com or ip4:192.0.2.1."
              key={`other:${settings.spf}`}
              value={[...spf.includes.filter((i) => !knownIncludes.includes(i)).map((i) => `include:${i}`), ...(spf.other ? [spf.other] : [])].join(' ')}
              onCommit={(v) => {
                const typed = parseSpf(`v=spf1 ${v}`)
                setSpf({ includes: [...spf.includes.filter((i) => knownIncludes.includes(i)), ...typed.includes], other: [...typed.own, typed.other].filter(Boolean).join(' ') })
              }}
            />
            <SettingSingle<SpfAll>
              label="Mail from anywhere else"
              options={[['?all', 'Allow'], ['~all', 'Mark as suspicious'], ['-all', 'Reject']]}
              value={spf.all}
              onChange={(all) => setSpf({ all })}
            />
            <pre>{settings.spf}</pre>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>DMARC</legend>
        <SettingSingle
          label="DMARC"
          name="Manage DMARC"
          options={MANAGE}
          value={settings.dmarc !== null ? 'on' : 'off'}
          onChange={(v) => {
            const { dmarcType: _old, ...rest } = settings
            commit({ ...rest, dmarc: v === 'on' ? DEFAULT_DMARC : null })
          }}
        />
        {settings.dmarc !== null && (
          <SettingSingle
            label="Policy set by"
            help="Some mail providers publish the policy for you through a CNAME."
            options={[['TXT', 'This profile'], ['CNAME', 'Mail provider']] as const}
            value={dmarcCname ? 'CNAME' : 'TXT'}
            onChange={setDmarcKind}
          />
        )}
        {dmarcCname && settings.dmarc !== null && (
          <SettingText label="Provider's DMARC host" key={`cname:${settings.dmarc}`} value={settings.dmarc} onCommit={(v) => commit({ ...settings, dmarc: v.trim() })} />
        )}
        {dmarcTags && (
          <>
            <SettingSingle<DmarcPolicy>
              label="Mail that fails checks"
              options={[['none', 'Monitor only'], ['quarantine', 'Send to spam'], ['reject', 'Block']]}
              value={(dmarcTags.get('p') as DmarcPolicy | undefined) ?? 'none'}
              onChange={(p) => setDmarcTag('p', p)}
            />
            <SettingText
              label="Send reports to"
              placeholder="dmarc@example.com"
              key={`rua:${reportTo}`}
              value={reportTo}
              onCommit={(v) => setDmarcTag('rua', v.trim() === '' ? '' : `mailto:${v.trim()}`)}
            />
            <pre>{settings.dmarc}</pre>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>DKIM</legend>
        <p>Removing a selector can break mail signing.</p>
        {settings.dkim.map((r, i) => (
          <div key={r.selector}>
            <div className="rule-title">
              <strong>{r.selector}</strong>
              <span className="badge">{r.type}</span>
              <span className="muted">{r.mode === 'shared' ? 'Same on every zone' : 'Per zone'}</span>
              <button type="button" onClick={() => updateRecord(i, null)}>Remove</button>
            </div>
            {r.mode === 'shared' ? (
              <SettingText label="Value" name={`${r.selector} value`} key={`${r.selector}:${r.value ?? ''}`} value={r.value ?? ''} onCommit={(v) => updateRecord(i, { ...r, value: v })} />
            ) : (
              zones.map((z) => (
                <SettingText
                  key={z.id}
                  label={z.name}
                  name={`${r.selector} value for ${z.name}`}
                  value={r.perZone?.[z.id] ?? ''}
                  onCommit={(v) => setZoneValue(i, z.id, v)}
                  {...(r.perZone?.[z.id] === undefined ? { help: 'Missing: this zone cannot sync until it has a value.' } : {})}
                />
              ))
            )}
          </div>
        ))}
        <h4>Add a DKIM record</h4>
        <SettingText label="Selector" placeholder="purelymail1" value={draft.selector} onChange={(selector) => setDraft({ ...draft, selector })} />
        <SettingSingle label="Record type" options={[['TXT', 'TXT'], ['CNAME', 'CNAME']] as const} value={draft.type} onChange={(type) => setDraft({ ...draft, type })} />
        <SettingSingle label="Value" options={[['shared', 'Same on every zone'], ['perZone', 'Different per zone']] as const} value={draft.mode} onChange={(mode) => setDraft({ ...draft, mode })} />
        {draft.mode === 'shared' && <SettingText label="Record value" value={draft.value} onChange={(value) => setDraft({ ...draft, value })} />}
        <div className="actions">
          <button type="button" onClick={addRecord}>Add DKIM record</button>
        </div>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  )
}
