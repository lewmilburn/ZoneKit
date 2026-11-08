import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { ZoneSummary } from '../../shared/ipc'
import { CACHING_FIELDS, DEV_MODE_FIELDS } from '../../shared/settingFields'
import { ProfileRuleList } from '../components/RuleForm'
import { SettingSingle, SettingText, Tabs, WarningBox } from '../components/ui'
import { SettingsProfile, ZoneSettings, type ZoneSettingsApi } from './ZoneSettings'
import { ZoneRules } from './ZoneRules'

const CACHE_PHASE = 'http_request_cache_settings'
type Tab = 'settings' | 'rules'
const TABS = [['settings', 'Settings'], ['rules', 'Cache Rules']] as const
type Values = Record<string, unknown>

const API: ZoneSettingsApi = { get: (id) => window.zonekeeper.zoneCachingGet(id), save: (input) => window.zonekeeper.zoneCachingSave(input) }

export function CachingProfile({ settings, onChange, zones }: { settings: Values; onChange: (s: Values) => void; zones: ReadonlyArray<{ name: string; plan: string | null }> }): JSX.Element {
  const [tab, setTab] = useState<Tab>('settings')
  const rules = (settings.cacheRules as Record<string, unknown>[] | undefined) ?? []
  return (
    <section>
      <Tabs<Tab> inline tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'settings' && <SettingsProfile zones={zones} fields={CACHING_FIELDS} settings={settings as Record<string, string | undefined>} onChange={onChange} />}
      {tab === 'rules' && <ProfileRuleList phase={CACHE_PHASE} rules={rules} onChange={(cacheRules) => onChange({ ...settings, cacheRules })} />}
    </section>
  )
}

type ZoneTab = Tab | 'purge'
const ZONE_TABS = [...TABS, ['purge', 'Purge']] as const
const DEV_API: ZoneSettingsApi = { get: (id) => window.zonekeeper.zoneDevModeGet(id), save: (input) => window.zonekeeper.zoneDevModeSave(input) }

export function ZoneCaching({ zone }: { zone: ZoneSummary }): JSX.Element {
  const [tab, setTab] = useState<ZoneTab>('settings')
  return (
    <section>
      <Tabs<ZoneTab> inline tabs={ZONE_TABS} active={tab} onChange={setTab} />
      {tab === 'settings' && (
        <>
          <ZoneSettings zone={zone} fields={CACHING_FIELDS} api={API} />
          <ZoneSettings zone={zone} fields={DEV_MODE_FIELDS} api={DEV_API} />
        </>
      )}
      {tab === 'rules' && <ZoneRules zone={zone} embedded heading="Cache" />}
      {tab === 'purge' && <ZonePurge zone={zone} />}
    </section>
  )
}

type PurgeKind = 'everything' | 'files' | 'hosts' | 'prefixes' | 'tags'
const PURGE_KINDS: ReadonlyArray<readonly [PurgeKind, string]> = [['everything', 'Everything'], ['files', 'URLs'], ['hosts', 'Hostnames'], ['prefixes', 'Prefixes'], ['tags', 'Cache tags']]
const PURGE_HINT: Record<PurgeKind, string> = {
  everything: '',
  files: `https://example.com/style.css`,
  hosts: 'images.example.com',
  prefixes: 'example.com/blog/',
  tags: 'product-page'
}

function ZonePurge({ zone }: { zone: ZoneSummary }): JSX.Element {
  const [mode, setMode] = useState<'purge' | 'invalidate'>('purge')
  const [kind, setKind] = useState<PurgeKind>('files')
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const values = text.split('\n').map((v) => v.trim()).filter(Boolean)

  async function purge(): Promise<void> {
    setBusy(true)
    setResult(null)
    try {
      const r = await window.zonekeeper.zonePurge({ zoneId: zone.id, kind, values: kind === 'everything' ? [] : values, mode, confirmed: true })
      const done = mode === 'invalidate' ? 'Invalidated' : 'Purged'
      setResult(r.ok ? { ok: true, text: kind === 'everything' ? `${done} everything.` : `${done} ${values.length} ${values.length === 1 ? 'entry' : 'entries'}.` } : { ok: false, text: r.error })
      if (r.ok) setText('')
    } catch (e) {
      setResult({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <section>
      <SettingSingle<'purge' | 'invalidate'>
        label="Action"
        help={mode === 'purge' ? 'Deletes cached files, so Cloudflare fetches fresh copies from your server.' : 'Marks cached files stale, so Cloudflare checks your server for updates.'}
        options={[['purge', 'Purge'], ['invalidate', 'Invalidate']]}
        value={mode}
        onChange={(m) => { setMode(m); setConfirming(false) }}
      />
      <SettingSingle<PurgeKind> label="What" options={PURGE_KINDS} value={kind} onChange={(k) => { setKind(k); setConfirming(false) }} />
      {kind !== 'everything' && (
        <SettingText label="One per line" multiline placeholder={PURGE_HINT[kind].replace('example.com', zone.name)} value={text} onChange={setText} help="Up to 100 at a time." />
      )}
      {confirming ? (
        <WarningBox alert>
          {mode === 'invalidate'
            ? kind === 'everything' ? `Invalidate all cached files for ${zone.name}?` : `Invalidate ${values.length} ${values.length === 1 ? 'entry' : 'entries'}?`
            : kind === 'everything' ? `Purge all cached files for ${zone.name}? Your origin will take the full load until the cache refills.` : `Purge ${values.length} ${values.length === 1 ? 'entry' : 'entries'} from the cache?`}
          <div className="actions">
            <button className="danger" disabled={busy} onClick={() => void purge()}>{mode === 'invalidate' ? 'Invalidate' : 'Purge'}</button>
            <button disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </WarningBox>
      ) : (
        <div className="actions">
          <button className="primary" disabled={busy || (kind !== 'everything' && (values.length === 0 || values.length > 100))} onClick={() => setConfirming(true)}>{mode === 'invalidate' ? 'Invalidate cache' : 'Purge cache'}</button>
        </div>
      )}
      {result && <p role={result.ok ? 'status' : 'alert'} className={result.ok ? 'muted' : 'error'}>{result.text}</p>}
    </section>
  )
}
