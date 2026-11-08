import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ParentLinks } from '../../shared/ipc'
import { useTopLevelZones } from '../screens/Zones'
import { ZonePicker } from './ui'

export interface Scope {
  /** "all" or the zone ID. */
  key: string
  /** Includes child zones. */
  zoneIds: string[]
}

/** All zones, or one zone with its children. */
export function ZoneScope({ children }: { children: (scope: Scope) => ComponentChildren }): JSX.Element {
  const zones = useTopLevelZones()
  const [selected, setSelected] = useState<string | null>(null)
  const [links, setLinks] = useState<ParentLinks>({})
  useEffect(() => {
    void window.zonekeeper.parentLinks().then((r) => r.ok && setLinks(r.value))
  }, [])
  const kids = (id: string): string[] => Object.keys(links).filter((c) => links[c] === id)
  const zoneIds = selected === 'all' ? [...zones.map((z) => z.id), ...Object.keys(links)] : selected ? [selected, ...kids(selected)] : []
  return (
    <ZonePicker zones={zones} allZones selected={selected} onSelect={setSelected}>
      {selected && zoneIds.length > 0 && <div key={selected}>{children({ key: selected, zoneIds })}</div>}
    </ZonePicker>
  )
}
