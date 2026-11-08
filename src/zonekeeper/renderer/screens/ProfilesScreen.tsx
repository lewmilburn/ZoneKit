import { plural } from '@app/shared/plural'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ProfileDto, ProfileItem, ZoneSummary } from '../../shared/ipc'
import type { EmailSettings, RulesSettings, SecuritySettings } from '../../shared/schemas'
import { COMPLIANCE_FIELDS, NETWORK_FIELDS, SPEED_FIELDS, SSL_FIELDS } from '../../shared/settingFields'
import { SecsetProfile, ZoneSecset } from './Secset'
import { CachingProfile, ZoneCaching } from './Caching'
import { SettingsProfile, ZoneSettings, type ZoneSettingsApi } from './ZoneSettings'
import { PageHeader, Panel, ProfileRow, ProfilesAndZones, SettingText, WarningBox, ZoneList } from '../components/ui'
import { EmailSetup } from './EmailScreen'
import { ZoneMail } from './ZoneMail'
import { SecurityProfile } from './SecurityProfile'
import { RulesProfile } from './RulesProfile'
import { SyncPanel, safe } from './SyncPanel'
import { RuleCountBadge } from '../components/RuleCounts'
import { getZones } from './Zones'
import { ZoneEmail } from './ZoneEmail'
import { ZoneRules } from './ZoneRules'
import { visibleZones } from './zoneGrouping'

/** Null for items without rules. */
function ruleCount(p: ProfileDto): { n: number; unit: string } | null {
  const s = p.settings as Record<string, unknown>
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
  if (p.item === 'security') return { n: len(s.firewall), unit: 'rule' }
  if (p.item === 'caching') return { n: len(s.cacheRules), unit: 'rule' }
  if (p.item === 'sechead') return { n: Object.keys((s.headers as object | undefined) ?? {}).length, unit: 'header' }
  if (p.item === 'rules') return { n: Object.values((s.phases as Record<string, unknown> | undefined) ?? {}).reduce<number>((a, v) => a + len(v), 0) + len(s.pageRules), unit: 'rule' }
  return null
}

type Mode ={ kind: 'list' } | { kind: 'edit'; id: string } | { kind: 'sync'; id: string }

const TITLES: Record<ProfileItem, string> = { security: 'WAF', sechead: 'Security Headers', secset: 'Security Settings', rules: 'Rules', email: 'Email', ssl: 'HTTPS', caching: 'Caching', speed: 'Speed', network: 'Network', compliance: 'Compliance' }
const NETWORK_API: ZoneSettingsApi = { get: (id) => window.zonekeeper.zoneNetworkGet(id), save: (input) => window.zonekeeper.zoneNetworkSave(input) }
const SSL_API: ZoneSettingsApi = { get: (id) => window.zonekeeper.zoneSslGet(id), save: (input) => window.zonekeeper.zoneSslSave(input) }
const SPEED_API: ZoneSettingsApi = { get: (id) => window.zonekeeper.zoneSpeedGet(id), save: (input) => window.zonekeeper.zoneSpeedSave(input) }

export function ProfilesScreen({ item, resetSignal = 0, onDirtyChange, initialProfileId = null, renderSettings, renderZone }: {
  item: ProfileItem
  resetSignal?: number
  onDirtyChange?: (dirty: boolean) => void
  initialProfileId?: string | null
  /** Overrides the settings editor. */
  renderSettings?: (settings: unknown, onChange: (settings: unknown) => void) => JSX.Element
  /** Overrides the zone page. */
  renderZone?: (zone: ZoneSummary) => JSX.Element
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const savedScroll = useRef<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [profiles, setProfiles] = useState<ProfileDto[]>([])
  const [zones, setZones] = useState<ZoneSummary[]>([])
  const [mode, setMode] = useState<Mode>(initialProfileId ? { kind: 'edit', id: initialProfileId } : { kind: 'list' })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [zonesLoading, setZonesLoading] = useState(true)
  const [zonesError, setZonesError] = useState<string | null>(null)
  const [openZone, setOpenZone] = useState<ZoneSummary | null>(null)
  const seenReset = useRef(resetSignal)
  const [childIds, setChildIds] = useState<ReadonlySet<string>>(new Set())

  const scroller = (): HTMLElement | null => rootRef.current?.closest<HTMLElement>('.content') ?? null
  const openZonePage = (z: ZoneSummary): void => {
    savedScroll.current = scroller()?.scrollTop ?? 0
    setConfirmLeave(false)
    setOpenZone(z)
  }
  const closeZonePage = (): void => {
    setOpenZone(null)
    setConfirmLeave(false)
    setDirty(false)
  }
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  // Sidebar click leaves the zone page
  useEffect(() => {
    if (resetSignal !== seenReset.current) closeZonePage()
    seenReset.current = resetSignal
  }, [resetSignal])
  // Restore the list's scroll position
  useLayoutEffect(() => {
    if (openZone === null && savedScroll.current !== null) {
      const el = scroller()
      if (el) el.scrollTop = savedScroll.current
      savedScroll.current = null
    }
  }, [openZone])

  const reload = useCallback(async (): Promise<void> => {
    const r = await safe(window.zonekeeper.profilesList(item))
    if (r.ok) setProfiles(r.value)
    else setError(r.error)
  }, [item])

  useEffect(() => {
    void safe(window.zonekeeper.parentLinks()).then((r) => r.ok && setChildIds(new Set(Object.keys(r.value))))
    void reload()
    setZonesLoading(true)
    setZonesError(null)
    getZones()
      .then((r) => {
        if (r.ok) setZones(r.value)
        else setZonesError(`Zones could not be loaded: ${r.error}`)
      })
      .catch(() => setZonesError('Zones could not be loaded.'))
      .finally(() => setZonesLoading(false))
  }, [reload])

  async function run(fn: () => Promise<{ ok: boolean } & { error?: string }>, done?: string): Promise<boolean> {
    setError(null)
    setNotice(null)
    const r = await fn()
    if (!r.ok) {
      setError(r.error ?? 'That failed, and no reason was given.')
      return false
    }
    if (done) setNotice(done)
    await reload()
    return true
  }

  const current = mode.kind === 'list' ? undefined : profiles.find((p) => p.id === mode.id)

  if (mode.kind === 'sync' && current) {
    return (
      <div className="profiles">
        <SyncPanel
          profileId={current.id}
          profileName={current.name}
          onClose={(message) => {
            setMode({ kind: 'list' })
            if (message) setNotice(message)
            void reload()
          }}
        />
      </div>
    )
  }

  if (mode.kind === 'edit' && current) {
    return (
      <EditProfile
        key={current.id}
        profile={current}
        zones={visibleZones(zones, childIds)}
        others={profiles.filter((p) => p.id !== current.id)}
        title={TITLES[item]}
        {...(renderSettings ? { renderSettings } : {})}
        onSaved={async (hasZones) => {
          await reload()
          setNotice(hasZones ? null : 'Profile saved.')
          setMode(hasZones ? { kind: 'sync', id: current.id } : { kind: 'list' })
        }}
        onBack={() => setMode({ kind: 'list' })}
        onDeleted={() => {
          setMode({ kind: 'list' })
          setNotice('Profile deleted.')
          void reload()
        }}
      />
    )
  }

  if (openZone) {
    return (
      <div className="profiles zone-page" ref={rootRef}>
        <PageHeader
          title={openZone.name}
          onBack={() => {
            if (dirty) setConfirmLeave(true)
            else closeZonePage()
          }}
        />
        {confirmLeave && (
          <WarningBox alert>
            <strong>Unsaved changes.</strong> Leave this zone and discard your edits?
            <div className="actions">
              <button className="danger" onClick={closeZonePage}>Discard and exit</button>
              <button onClick={() => setConfirmLeave(false)}>Keep editing</button>
            </div>
          </WarningBox>
        )}
        {profiles.some((p) => p.zoneIds.includes(openZone.id)) && (
          <ZoneList>
            {profiles.filter((p) => p.zoneIds.includes(openZone.id)).map((p) => (
              <ProfileRow key={p.id} profileId={p.id} version={p.version ?? 0} name={p.name} zoneCount={p.zoneIds.length} onSync={() => setMode({ kind: 'sync', id: p.id })} onOpen={() => setMode({ kind: 'edit', id: p.id })} />
            ))}
          </ZoneList>
        )}
        {renderZone ? (
          renderZone(openZone)
        ) : item === 'secset' ? (
          <ZoneSecset key={openZone.id} zone={openZone} />
        ) : item === 'speed' ? (
          <ZoneSettings key={openZone.id} zone={openZone} fields={SPEED_FIELDS} api={SPEED_API} />
        ) : item === 'network' ? (
          <ZoneSettings key={openZone.id} zone={openZone} fields={NETWORK_FIELDS} api={NETWORK_API} />
        ) : item === 'caching' ? (
          <ZoneCaching key={openZone.id} zone={openZone} />
        ) : item === 'ssl' ? (
          <ZoneSettings key={openZone.id} zone={openZone} fields={SSL_FIELDS} api={SSL_API} />
        ) : item !== 'email' ? (
          <ZoneRules key={openZone.id} zone={openZone} embedded heading={item === 'security' ? 'Security' : 'Rules'} onDirtyChange={setDirty} />
        ) : (
          <>
            <h3>Mail servers</h3>
            <ZoneMail key={`mail:${openZone.id}`} zone={openZone} />
            <h3>Email security</h3>
            <ZoneEmail key={openZone.id} zone={openZone} onDirtyChange={setDirty} />
          </>
        )}
      </div>
    )
  }

  return (
    <div className="profiles" ref={rootRef}>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => window.zonekeeper.profileCreate(item, newName), 'Profile created.').then((ok) => ok && setNewName(''))
        }}
      >
        <input aria-label="New profile name" placeholder="New profile name" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
        <button type="submit" className="primary" disabled={newName.trim() === ''}>Create profile</button>
      </form>

      {zonesLoading && <p role="status">Loading zones...</p>}
      {zonesError && <p className="error" role="alert">{zonesError}</p>}
      <ProfilesAndZones
            profiles={profiles}
            zones={visibleZones(zones, childIds)}
            onOpenZone={openZonePage}
            {...(item === 'security' || item === 'rules' ? { zoneMeta: (z: ZoneSummary) => <RuleCountBadge zoneId={z.id} kind={item === 'security' ? 'waf' : 'rules'} /> } : {})}
            renderMeta={(p) => {
              const c = ruleCount(p)
              return c && <span className="badge" aria-label={`${c.n} ${c.unit}s`}>{c.n}</span>
            }}
            onSync={(p) => setMode({ kind: 'sync', id: p.id })}
            onOpenProfile={(p) => setMode({ kind: 'edit', id: p.id })}
      />
    </div>
  )
}

function EditProfile(props: {
  profile: ProfileDto
  zones: ZoneSummary[]
  others: ProfileDto[]
  title: string
  renderSettings?: (settings: unknown, onChange: (settings: unknown) => void) => JSX.Element
  onSaved: (hasZones: boolean) => Promise<void>
  onBack: () => void
  onDeleted: () => void
}): JSX.Element {
  const { profile, zones, others } = props
  const [deleting, setDeleting] = useState(false)
  const [name, setName] = useState(profile.name)
  const [zoneIds, setZoneIds] = useState<string[]>(profile.zoneIds)
  const [settings, setSettings] = useState<unknown>(profile.settings)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)
  const [editorKey, setEditorKey] = useState(0)

  const selected = zones.filter((z) => zoneIds.includes(z.id)).map((z) => ({ id: z.id, name: z.name }))

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    const r = await safe(window.zonekeeper.profileUpdate({ id: profile.id, name, zoneIds, settings }))
    setSaving(false)
    if (r.ok) await props.onSaved(r.value.zoneIds.length > 0)
    else setError(r.error)
  }

  const exitButtons = (
    <>
      <button className="primary" disabled={saving || name.trim() === ''} onClick={() => void save()}>Save and Sync</button>
      <button onClick={props.onBack}>Discard and exit</button>
    </>
  )

  return (
    <div className="profiles">
      <PageHeader title={`${props.title}: edit profile`} actions={exitButtons} />
      <SettingText label="Name" value={name} onChange={setName} />

      <fieldset>
        <legend>Zones in this profile</legend>
        {zones.length === 0 && <p className="muted">No zones loaded.</p>}
        {zones.map((z) => {
          const also = others.filter((o) => o.zoneIds.includes(z.id)).map((o) => o.name)
          return (
            <label key={z.id} className="check">
              <input
                type="checkbox"
                checked={zoneIds.includes(z.id)}
                onChange={(e) => setZoneIds((ids) => (e.currentTarget.checked ? [...ids, z.id] : ids.filter((x) => x !== z.id)))}
              />{' '}
              {z.name}
              {also.length > 0 && <span className="muted"> (also in {also.join(', ')})</span>}
            </label>
          )
        })}
      </fieldset>

      {profile.zoneIds.length === 0 && zoneIds.length === 1 && (
        <Panel>
          <p>Copy this zone&apos;s settings into the profile?</p>
          <button
            disabled={importing}
            onClick={async () => {
              setImporting(true)
              setImportNote(null)
              const r = await safe(window.zonekeeper.profileImportZone({ profileId: profile.id, zoneId: zoneIds[0]! }))
              setImporting(false)
              if (!r.ok) setError(r.error)
              else {
                setSettings(r.value.settings)
                setEditorKey((k) => k + 1)
                setImportNote(r.value.unavailable.length > 0 ? `Imported, except what your token can't read: ${r.value.unavailable.join(', ')}.` : 'Imported.')
              }
            }}
          >
            Import from zone
          </button>
          {importNote && <p role="status">{importNote}</p>}
        </Panel>
      )}
      {props.renderSettings ? (
        <div key={editorKey}>{props.renderSettings(settings, setSettings)}</div>
      ) : profile.item === 'secset' ? (
        <SecsetProfile key={editorKey} zones={zones.filter((z) => zoneIds.includes(z.id))} settings={settings as Record<string, unknown>} onChange={setSettings} />
      ) : profile.item === 'speed' ? (
        <SettingsProfile key={editorKey} zones={zones.filter((z) => zoneIds.includes(z.id))} fields={SPEED_FIELDS} settings={settings as Record<string, string | undefined>} onChange={setSettings} />
      ) : profile.item === 'network' ? (
        <SettingsProfile key={editorKey} zones={zones.filter((z) => zoneIds.includes(z.id))} fields={NETWORK_FIELDS} settings={settings as Record<string, string | undefined>} onChange={setSettings} />
      ) : profile.item === 'compliance' ? (
        <SettingsProfile key={editorKey} zones={zones.filter((z) => zoneIds.includes(z.id))} fields={COMPLIANCE_FIELDS} settings={settings as Record<string, string | undefined>} onChange={setSettings} />
      ) : profile.item === 'caching' ? (
        <CachingProfile key={editorKey} zones={zones.filter((z) => zoneIds.includes(z.id))} settings={settings as Record<string, unknown>} onChange={setSettings} />
      ) : profile.item === 'ssl' ? (
        <SettingsProfile key={editorKey} zones={zones.filter((z) => zoneIds.includes(z.id))} fields={SSL_FIELDS} settings={settings as Record<string, string | undefined>} onChange={setSettings} />
      ) : profile.item === 'security' ? (
        <SecurityProfile key={editorKey} settings={settings as SecuritySettings} onChange={setSettings} />
      ) : profile.item === 'rules' ? (
        <RulesProfile key={editorKey} settings={settings as RulesSettings} onChange={setSettings} />
      ) : (
        <EmailSetup key={editorKey} settings={settings as EmailSettings} zones={selected} onChange={setSettings} />
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        {exitButtons}
        <button className="danger" onClick={() => setDeleting(true)}>Delete profile</button>
      </div>
      {deleting && (
        <WarningBox alert>
          Delete "{profile.name}"?
          <div className="actions">
            <button
              className="danger"
              onClick={async () => {
                const r = await safe(window.zonekeeper.profileDelete(profile.id))
                if (r.ok) props.onDeleted()
                else {
                  setDeleting(false)
                  setError(r.error)
                }
              }}
            >
              Yes, delete
            </button>
            <button onClick={() => setDeleting(false)}>No</button>
          </div>
        </WarningBox>
      )}
    </div>
  )
}
