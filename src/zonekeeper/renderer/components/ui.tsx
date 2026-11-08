import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren, JSX } from 'preact'
import { PageHeader, WarningBox, ZoneList, ZoneRow } from '@app/renderer/ui'
import type { DriftView } from '../../shared/ipc'
import { filterZones, useZoneFilter } from '../zoneFilter'
import { checkDrift } from '../drift'

// Shared components plus ZoneKeeper's own.
export * from '@app/renderer/ui'

function useDrift(profileId: string, zoneCount: number, version: number): { state: 'checking' | 'ok' | 'drift' | 'error' | 'none'; view: DriftView | null; error: string | null } {
  const [view, setView] = useState<DriftView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (zoneCount === 0) return
    let live = true
    setDone(false)
    setView(null)
    setError(null)
    void checkDrift(profileId).then((r) => {
      if (!live) return
      if (r.ok) setView(r.value)
      else setError(r.error)
      setDone(true)
    })
    return () => {
      live = false
    }
  }, [profileId, zoneCount, version])
  if (zoneCount === 0) return { state: 'none', view: null, error: null }
  if (!done) return { state: 'checking', view, error }
  if (error) return { state: 'error', view, error }
  return { state: view?.inSync ? 'ok' : 'drift', view, error }
}

function DriftDetails({ view, error }: { view: DriftView | null; error: string | null }): JSX.Element {
  if (error) return <WarningBox alert>The check couldn&apos;t run: {error}</WarningBox>
  const off = (view?.zones ?? []).filter((z) => z.differences.length > 0 || z.failure)
  return (
    <WarningBox>
      {off.length} {off.length === 1 ? 'zone no longer matches' : 'zones no longer match'} this profile.
      <ul className="plain-list">
        {off.map((z) => (
          <li key={z.zoneId}>
            <strong>{z.zoneName}</strong>: {z.failure ? `couldn't be read: ${z.failure}` : z.differences.join(', ')}
          </li>
        ))}
      </ul>
    </WarningBox>
  )
}

// Fixed box so it spins on its centre.
function SyncSpinner(): JSX.Element {
  return (
    <svg className="sync-spin" role="status" aria-label="Checking sync" viewBox="0 0 16 16" width="16" height="16">
      <title>Checking sync</title>
      <path d="M8 2a6 6 0 1 1-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** With `profileId`, shows if its zones are in sync. */
export function ProfileRow(props: { name: ComponentChildren; zoneCount: number; meta?: ComponentChildren; actions?: ComponentChildren; profileId?: string; version?: number; onSync?: () => void; onOpen?: () => void }): JSX.Element {
  const drift = useDrift(props.profileId ?? '', props.profileId ? props.zoneCount : 0, props.version ?? 0)
  const [open, setOpen] = useState(false)
  const off = drift.state === 'drift' || drift.state === 'error'
  const syncable = drift.state === 'drift' && props.onSync
  // Inner buttons don't open the row
  const inner = (fn: () => void) => (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    fn()
  }
  const { onOpen } = props
  return (
    <div className="profile-row">
      <div
        className={onOpen ? 'row-head clickable' : 'row-head'}
        {...(onOpen ? { role: 'button', tabIndex: 0, onClick: onOpen, onKeyDown: (e: { target: EventTarget | null; currentTarget: EventTarget | null; key: string }) => e.target === e.currentTarget && e.key === 'Enter' && onOpen() } : {})}
      >
        <span className="row-name">{props.name}</span>
        <span className="badge">{props.zoneCount} {props.zoneCount === 1 ? 'zone' : 'zones'}</span>
        {drift.state === 'checking' && <SyncSpinner />}
        {drift.state === 'ok' && <span className="sync-ok" role="img" aria-label="In sync" title="In sync">✓</span>}
        {off && (
          <button
            className={drift.state === 'error' ? 'warn-icon unknown' : 'warn-icon'}
            aria-expanded={open}
            aria-label={drift.state === 'error' ? "Couldn't check sync, show details" : 'Out of sync, show details'}
            title={drift.state === 'error' ? "Couldn't check sync" : 'Out of sync'}
            onClick={inner(() => setOpen((o) => !o))}
          >
            {drift.state === 'error' ? '?' : '⚠'}
          </button>
        )}
        {(props.actions || syncable) && (
          <span className="row-actions">
            {syncable && <button onClick={inner(props.onSync!)}>Sync</button>}
            {props.actions}
          </span>
        )}
        {props.meta && <span className="row-count">{props.meta}</span>}
        {onOpen && <span className="chev" aria-hidden="true">›</span>}
      </div>
      {open && off && <DriftDetails view={drift.view} error={drift.error} />}
    </div>
  )
}

export function ProfilesAndZones<P extends { id: string; name: string; zoneIds: string[]; version?: number }, Z extends { id: string; name: string }>(props: {
  profiles: readonly P[]
  zones: readonly Z[]
  onOpenZone: (zone: Z) => void
  renderName?: (profile: P) => ComponentChildren
  onOpenProfile: (profile: P) => void
  renderMeta?: (profile: P) => ComponentChildren
  onSync?: (profile: P) => void
  zoneMeta?: (zone: Z) => ComponentChildren
}): JSX.Element {
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
  const profiles = [...props.profiles].sort(byName)
  const filter = useZoneFilter()
  const zones = filterZones(props.zones, filter)
  // Applied tag for the top bar zone
  const applied = (p: P): ComponentChildren =>
    filter === null ? null : p.zoneIds.includes(filter) ? <span className="badge">Applied</span> : <span className="badge muted">Not applied</span>
  return (
    <>
      <h3>Profiles</h3>
      {profiles.length === 0 && <p className="muted">No profiles yet.</p>}
      {profiles.length > 0 && (
        <ZoneList>
          {profiles.map((p) => (
            <ProfileRow
              key={p.id}
              profileId={p.id}
              version={p.version ?? 0}
              name={<>{props.renderName ? props.renderName(p) : p.name} {applied(p)}</>}
              zoneCount={p.zoneIds.length}
              meta={props.renderMeta?.(p)}
              onOpen={() => props.onOpenProfile(p)}
              {...(props.onSync ? { onSync: () => props.onSync?.(p) } : {})}
            />
          ))}
        </ZoneList>
      )}
      <h3>Zones</h3>
      <ZoneList>
        {zones.sort(byName).map((z) => (
          <ZoneRow
            key={z.id}
            name={z.name}
            onOpen={() => props.onOpenZone(z)}
            meta={
              <>{profiles.filter((p) => p.zoneIds.includes(z.id)).map((p) => <span key={p.id} className="badge">{p.name}</span>)}</>
            }
            count={props.zoneMeta?.(z)}
          />
        ))}
      </ZoneList>
    </>
  )
}

/** Follows the top bar zone. */
export function ZonePicker(props: {
  zones: ReadonlyArray<{ id: string; name: string; meta?: ComponentChildren }>
  selected: string | null
  onSelect: (id: string | null) => void
  allZones?: boolean
  children: ComponentChildren
}): JSX.Element {
  const filter = useZoneFilter()
  // A top bar zone opens straight away
  useEffect(() => {
    if (filter !== null && props.selected !== filter && props.zones.some((z) => z.id === filter)) props.onSelect(filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, props.zones.length])
  if (filter !== null && props.selected === filter) {
    return (
      <div className="zone-page">
        <PageHeader title={props.zones.find((z) => z.id === filter)?.name} />
        {props.children}
      </div>
    )
  }
  if (props.selected === null) {
    return (
      <ZoneList>
        {props.allZones && filter === null && <ZoneRow name={<strong>All zones</strong>} onOpen={() => props.onSelect('all')} />}
        {filterZones(props.zones, filter).map((z) => <ZoneRow key={z.id} name={z.name} meta={z.meta} onOpen={() => props.onSelect(z.id)} />)}
      </ZoneList>
    )
  }
  const name = props.selected === 'all' ? 'All zones' : props.zones.find((z) => z.id === props.selected)?.name
  return (
    <div className="zone-page">
      <PageHeader title={name} onBack={() => props.onSelect(null)} />
      {props.children}
    </div>
  )
}
