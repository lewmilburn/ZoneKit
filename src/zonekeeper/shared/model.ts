export type ItemKind = 'security' | 'sechead' | 'secset' | 'speed' | 'rules' | 'email' | 'www' | 'ssl' | 'caching' | 'network' | 'compliance'

export interface Profile<S> {
  id: string
  item: ItemKind
  name: string
  version: number
  zoneIds: string[]
  settings: S
  updatedAt: string
}

export interface Entry {
  /** Unique across all areas. */
  key: string
  area: string
  value: unknown
  order?: number
}

export type Change =
  | { type: 'unchanged' | 'add'; entry: Entry }
  /** `owned`: the profile's own leftover, removed without asking. */
  | { type: 'extra'; actual: Entry; owned?: true }
  /** `expected`: the zone still has what the profile last wrote. */
  | { type: 'different'; desired: Entry; actual: Entry; expected?: true }
