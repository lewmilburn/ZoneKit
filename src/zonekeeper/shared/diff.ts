import type { Change, Entry } from './model'
import { isPlain } from './plain'

const SERVER_FIELDS = new Set(['id', 'version', 'last_updated'])

/** Top level only: nested `id`s are real config. */
export function stripServerFields<T>(value: T): T {
  if (!isPlain(value)) return value
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value)) {
    if (!SERVER_FIELDS.has(k)) Object.defineProperty(out, k, { value: value[k], enumerable: true, writable: true, configurable: true })
  }
  return out as T
}

/** Sorted keys, array order kept. */
function canon(v: unknown): string {
  if (v === undefined) return 'u'
  if (v === null) return 'z'
  switch (typeof v) {
    case 'string':
      return 's' + JSON.stringify(v)
    case 'number':
      return 'n' + (Object.is(v, -0) ? '0' : String(v))
    case 'boolean':
      return v ? 'T' : 'F'
    case 'bigint':
      return 'i' + String(v)
    case 'object':
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
      if (isPlain(v)) {
        const keys = Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
      }
  }
  throw new Error(`Cannot compare value of type ${typeof v}`)
}

function fingerprint(e: Entry): string {
  return canon([e.area, canon(stripServerFields(e.value)), e.order])
}

function indexByKey(entries: Entry[], label: string): Map<string, Entry> {
  const map = new Map<string, Entry>()
  for (const entry of entries) {
    if (map.has(entry.key)) throw new Error(`Duplicate key in ${label} entries: ${entry.key}`)
    map.set(entry.key, entry)
  }
  return map
}

/** Desired order first, then extras. */
export function diffEntries(desired: Entry[], actual: Entry[]): Change[] {
  const want = indexByKey(desired, 'desired')
  const have = indexByKey(actual, 'actual')
  const changes: Change[] = []
  for (const d of desired) {
    const a = have.get(d.key)
    if (!a) changes.push({ type: 'add', entry: d })
    else if (fingerprint(d) === fingerprint(a)) changes.push({ type: 'unchanged', entry: d })
    else changes.push({ type: 'different', desired: d, actual: a })
  }
  for (const a of actual) {
    if (!want.has(a.key)) changes.push({ type: 'extra', actual: a })
  }
  return changes
}

export function isConflict(c: Change): boolean {
  return (c.type === 'extra' && !c.owned) || (c.type === 'different' && !c.expected)
}
