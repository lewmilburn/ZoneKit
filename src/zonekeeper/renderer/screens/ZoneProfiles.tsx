import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { PROFILE_ITEMS, type ProfileDto, type ProfileItem, type ZoneSummary } from '../../shared/ipc'
import { ZoneList, ZoneRow } from '../components/ui'

const ITEM_LABELS: Record<ProfileItem, string> = { security: 'WAF', sechead: 'Security Headers', secset: 'Security Settings', rules: 'Rules', email: 'Email', ssl: 'HTTPS', caching: 'Caching', speed: 'Speed', network: 'Network', compliance: 'Compliance' }

export function ZoneProfiles({ zone, onOpen }: { zone: ZoneSummary; onOpen: (item: ProfileItem, profileId: string) => void }): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void Promise.all(PROFILE_ITEMS.map((item) => window.zonekeeper.profilesList(item))).then((lists) => {
      const found: ProfileDto[] = []
      for (const r of lists) {
        if (!r.ok) return setError(r.error)
        found.push(...r.value.filter((p) => p.zoneIds.includes(zone.id)))
      }
      setProfiles(found)
    })
  }, [zone.id])

  if (error) return <p role="alert" className="error">{error}</p>
  if (!profiles) return <p role="status">Loading...</p>
  if (profiles.length === 0) return <p className="muted">This zone isn&apos;t in any profiles.</p>
  return (
    <ZoneList>
      {profiles.map((p) => (
        <ZoneRow key={p.id} name={p.name} meta={<span className="badge">{ITEM_LABELS[p.item]}</span>} onOpen={() => onOpen(p.item, p.id)} />
      ))}
    </ZoneList>
  )
}
