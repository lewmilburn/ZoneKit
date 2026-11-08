import { describe, expect, it } from 'vitest'
import { groupZones, visibleZones } from '../../src/zonekeeper/renderer/screens/zoneGrouping'
import type { ProfileDto, ZoneSummary } from '../../src/zonekeeper/shared/ipc'

const z = (id: string, name: string): ZoneSummary => ({ id, name }) as ZoneSummary
const p = (id: string, name: string, zoneIds: string[]): ProfileDto => ({ id, name, zoneIds, item: 'rules', settings: {} }) as unknown as ProfileDto

describe('visibleZones', () => {
  it('hides child zones only', () => {
    const zones = [z('1', 'a.com'), z('2', 'b.com')]
    expect(visibleZones(zones, new Set(['2']))).toEqual([zones[0]])
    expect(visibleZones(zones, new Set())).toEqual(zones)
  })
})

describe('groupZones', () => {
  it('sorts, groups, and keeps unknown zone ids', () => {
    const zones = [z('1', 'c.com'), z('2', 'a.com'), z('3', 'b.com')]
    const r = groupZones([p('p', 'P', ['1', '9', '2'])], zones)
    expect(r.groups[0].zones.map((m) => m.id)).toEqual(['2', '1', '9'])
    expect(r.groups[0].zones[2].zone).toBeNull()
    expect(r.ungrouped.map((x) => x.id)).toEqual(['3'])
    expect(r.owner.get('1')?.id).toBe('p')
  })
})
