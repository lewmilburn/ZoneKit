import { useEffect, useState } from 'preact/hooks'

/** Top bar zone, null is All zones. */
let current: string | null = null
const listeners = new Set<(id: string | null) => void>()

export function setZoneFilter(id: string | null): void {
  current = id
  for (const l of listeners) l(id)
}

export function useZoneFilter(): string | null {
  const [id, setId] = useState(current)
  useEffect(() => {
    listeners.add(setId)
    return () => void listeners.delete(setId)
  }, [])
  return id
}

export function filterZones<Z extends { id: string }>(zones: readonly Z[], filter: string | null): Z[] {
  return filter === null ? [...zones] : zones.filter((z) => z.id === filter)
}
