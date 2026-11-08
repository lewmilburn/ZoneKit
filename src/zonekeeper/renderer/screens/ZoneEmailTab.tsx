import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ProfileDto, ZoneSummary } from '../../shared/ipc'
import { ZoneDmarcReports } from './ZoneDnssec'
import { ZoneEmail } from './ZoneEmail'
import { ZoneMail } from './ZoneMail'

function Managed({ profiles, onOpen }: { profiles: ProfileDto[]; onOpen: (profileId: string) => void }): JSX.Element {
  if (profiles.length === 1) {
    return (
      <p>
        Managed by a profile. <button className="link" onClick={() => onOpen((profiles[0] as ProfileDto).id)}>Open in Email</button>
      </p>
    )
  }
  return (
    <p>
      Managed by profiles:{' '}
      {profiles.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ', '}
          <button className="link" onClick={() => onOpen(p.id)}>{p.name}</button>
        </span>
      ))}
    </p>
  )
}

/** Profile-managed records are edited from the Email menu. */
export function ZoneEmailTab({ zone, onOpenEmail }: { zone: ZoneSummary; onOpenEmail: (profileId: string) => void }): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.zonekeeper.profilesList('email').then((r) => {
      if (!r.ok) return setError(`Your email profiles couldn't be read: ${r.error}`)
      setProfiles(r.value.filter((p) => p.zoneIds.includes(zone.id)))
    })
  }, [zone.id])

  if (error) return <p role="alert" className="error">{error}</p>
  if (!profiles) return <p role="status">Loading...</p>
  const settings = (p: ProfileDto): { mx?: unknown; spf?: unknown; dmarc?: unknown; dkim?: unknown[] } => p.settings as never
  const mail = profiles.filter((p) => settings(p).mx !== undefined)
  const security = profiles.filter((p) => settings(p).spf !== null || settings(p).dmarc !== null || (settings(p).dkim ?? []).length > 0)
  return (
    <div>
      <h3>Mail servers</h3>
      {mail.length > 0 ? <Managed profiles={mail} onOpen={onOpenEmail} /> : <ZoneMail zone={zone} />}
      <h3>Email security</h3>
      {security.length > 0 ? <Managed profiles={security} onOpen={onOpenEmail} /> : <ZoneEmail zone={zone} />}
      <h3>DMARC reports</h3>
      <ZoneDmarcReports zone={zone} />
    </div>
  )
}
