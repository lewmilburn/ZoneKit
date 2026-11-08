import type { ProfileDto, ZoneSummary } from '../../shared/ipc'

/** Hides child zones. */
export function visibleZones(zones: ZoneSummary[], childZoneIds: ReadonlySet<string>): ZoneSummary[] {
  return zones.filter((z) => !childZoneIds.has(z.id))
}

export const NO_CHILD_ZONES: ReadonlySet<string> = new Set()

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)

export type ProfileGroup = { profile: ProfileDto; zones: Array<{ id: string; zone: ZoneSummary | null }> }

/** Sorted by name, unknown zone IDs last. */
export function groupZones(
  profiles: ProfileDto[],
  zones: ZoneSummary[]
): { groups: ProfileGroup[]; ungrouped: ZoneSummary[]; owner: Map<string, ProfileDto> } {
  const known = new Map(zones.map((z) => [z.id, z]))
  const owner = new Map<string, ProfileDto>()
  const groups = [...profiles].sort(byName).map((profile) => {
    for (const id of profile.zoneIds) owner.set(id, profile)
    const members = profile.zoneIds.map((id) => ({ id, zone: known.get(id) ?? null }))
    members.sort((a, b) => (a.zone && b.zone ? byName(a.zone, b.zone) : a.zone ? -1 : b.zone ? 1 : a.id.localeCompare(b.id)))
    return { profile, zones: members }
  })
  const ungrouped = zones.filter((z) => !owner.has(z.id)).sort(byName)
  return { groups, ungrouped, owner }
}
