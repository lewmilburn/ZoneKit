import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { IpcResult, ParentLinks, ProfileItem, ZoneSummary } from '../../shared/ipc'
import { useDnssecStatuses } from './ZoneDnssec'
import { filterZones, useZoneFilter } from '../zoneFilter'
import { forgetRuleCounts } from '../components/RuleCounts'
import { errorText } from '../../shared/errorText'
import { ZoneDns } from './ZoneDns'
import { ZoneParent } from './ZoneParent'

// Cleared when the token changes.
let cachedZones: ZoneSummary[] | null = null
let cachedLinks: ParentLinks | null = null
let authGeneration = 0
window.zonekeeper.onAuthChanged(() => {
  cachedZones = null
  cachedLinks = null
  authGeneration++
})

async function getLinks(): Promise<ParentLinks> {
  if (cachedLinks) return cachedLinks
  const generation = authGeneration
  const r = await window.zonekeeper.parentLinks()
  // On failure every zone shows as top level
  const links = r.ok ? r.value : {}
  if (r.ok && generation === authGeneration) cachedLinks = links
  return links
}

export async function getZones(): Promise<IpcResult<ZoneSummary[]>> {
  if (cachedZones) return { ok: true, value: cachedZones }
  const generation = authGeneration
  const r = await window.zonekeeper.listZones()
  if (r.ok && generation === authGeneration) cachedZones = r.value
  return r
}

export function useChildZoneIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set(Object.keys(cachedLinks ?? {})))
  useEffect(() => {
    void getLinks().then((l) => setIds(new Set(Object.keys(l))))
  }, [])
  return ids
}

/** Empty until child zones are known. */
export function useTopLevelZones(): ZoneSummary[] {
  const [zones, setZones] = useState<ZoneSummary[]>(() => (cachedZones && cachedLinks ? cachedZones.filter((z) => !cachedLinks?.[z.id]) : []))
  useEffect(() => {
    void Promise.all([getZones(), getLinks()]).then(([r, links]) => r.ok && setZones(r.value.filter((z) => !links[z.id])))
  }, [])
  return zones
}

export function Zones({ onOpenProfile }: { onOpenProfile: (item: ProfileItem, profileId: string) => void }): JSX.Element {
  const [zones, setZones] = useState<ZoneSummary[] | null>(cachedZones)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(cachedZones === null)
  const [openZone, setOpenZone] = useState<ZoneSummary | null>(null)
  const [links, setLinksState] = useState<ParentLinks | null>(cachedLinks)
  const setLinks = (l: ParentLinks): void => {
    cachedLinks = l
    setLinksState(l)
  }
  // Only the latest request may update the screen.
  const latest = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const id = ++latest.current
    const generation = authGeneration
    setLoading(true)
    setError(null)
    cachedLinks = null
    forgetRuleCounts()
    void getLinks().then(setLinksState)
    try {
      const r = await window.zonekeeper.listZones()
      if (r.ok && generation === authGeneration) cachedZones = r.value
      if (id !== latest.current) return
      if (r.ok) setZones(r.value)
      else {
        setZones(null)
        setError(r.error)
      }
    } catch (e) {
      if (id !== latest.current) return
      setZones(null)
      setError(errorText(e))
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void getLinks().then(setLinksState)
    if (cachedZones === null) void load()
    return () => {
      latest.current++
    }
  }, [load])

  // Wait for parent links, so children don't flash in
  const ready = zones !== null && links !== null
  const filter = useZoneFilter()
  const topLevel = ready ? filterZones(zones.filter((z) => !links[z.id]), filter) : []
  const dnssec = useDnssecStatuses(topLevel.map((z) => z.id))
  const childrenOf = (id: string): ZoneSummary[] => (zones ?? []).filter((z) => links?.[z.id] === id)
  const DNSSEC_TEXT: Record<string, string> = { active: 'On', pending: 'Pending', disabled: 'Off', 'pending-disabled': 'Turning off' }
  const row = (z: ZoneSummary): JSX.Element => {
    const kids = childrenOf(z.id)
    const d = dnssec[z.id]
    return (
      <tr key={z.id} className="clickable" tabIndex={0} onClick={() => setOpenZone(z)} onKeyDown={(e) => e.key === 'Enter' && setOpenZone(z)}>
        <td className="zone-name">{z.name}</td>
        <td>{z.status ?? '-'}</td>
        <td>{z.plan ?? '-'}</td>
        <td>{d ? DNSSEC_TEXT[d] ?? d : <span className="muted">...</span>}</td>
        <td>{kids.length > 0 ? kids.slice(0, 2).map((k) => k.name).join(', ') + (kids.length > 2 ? ', more...' : '') : <span className="muted">-</span>}</td>
      </tr>
    )
  }

  // A top bar zone opens straight away, with no list to go back to
  const filtered = filter !== null && openZone === null ? topLevel.find((z) => z.id === filter) ?? null : null
  const shown = openZone ?? filtered
  if (shown) {
    return (
      <ZoneDns
        key={`dns:${shown.id}`}
        zone={shown}
        {...(filtered ? {} : { onBack: () => setOpenZone(null) })}
        onOpenProfile={onOpenProfile}
        parentPanel={<ZoneParent key={`${shown.id}:${links?.[shown.id] ?? ''}`} zone={shown} zones={zones ?? []} links={links ?? {}} onChange={setLinks} onOpenZone={setOpenZone} />}
      />
    )
  }

  return (
    <div className="zones">
      <div className="actions">
        <button onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        <span className="muted" role="status">
          {loading || (zones && !ready) ? 'Loading...' : ready ? `${topLevel.length} ${topLevel.length === 1 ? 'zone' : 'zones'}` : ''}
        </span>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loading && ready && zones.length === 0 && <p>No zones found for this token</p>}
      {topLevel.length > 0 && (
        <div className="table-scroll">
          <table className="zone-table">
            <thead><tr><th>Zone</th><th>Status</th><th>Plan</th><th>DNSSEC</th><th>Child zones</th></tr></thead>
            <tbody>{topLevel.map(row)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
