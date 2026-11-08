import { isPlain, ownObject } from './plain'

const TOKEN = '{zone}'

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (isPlain(value)) {
    return ownObject(Object.keys(value).map((k) => [k, mapStrings(value[k], fn)]))
  }
  return value
}

function requireZone(zoneName: string): void {
  if (!zoneName) throw new Error('Zone name must not be empty')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function resolveZone<T>(value: T, zoneName: string): T {
  requireZone(zoneName)
  return mapStrings(value, (s) => s.split(TOKEN).join(zoneName)) as T
}

/** Only where the zone is the whole host: a.com, "a.com", https://a.com/x. */
export function abstractZone<T>(value: T, zoneName: string): T {
  requireZone(zoneName)
  const z = escapeRegex(zoneName.toLowerCase())
  // groups: 1 www (whole string) | 2 quote, 3 www | 4 scheme, 5 www
  const re = new RegExp(
    `^(www\\.)?${z}$` +
      `|(["'])(www\\.)?${z}\\2` +
      `|([A-Za-z][A-Za-z0-9+.-]*://)(www\\.)?${z}(?=$|[/?#]|:\\d|["'\\s,)}\\]])`,
    'g'
  )
  return mapStrings(value, (s) =>
    s.replace(re, (m, w1?: string, q?: string, w2?: string, scheme?: string, w3?: string) => {
      if (scheme !== undefined) return `${scheme}${w3 ? 'www.' : ''}${TOKEN}`
      if (q !== undefined) return `${q}${w2 ? 'www.' : ''}${TOKEN}${q}`
      return `${w1 ? 'www.' : ''}${TOKEN}`
    })
  ) as T
}

/** Strings that still mention the zone, over-reported on purpose. */
export function findZoneLiterals(value: unknown, zoneName: string): string[] {
  requireZone(zoneName)
  const lower = zoneName.toLowerCase()
  const needles = [lower, lower.split('.').join('\\.'), lower.split('.').join('[.]')]
  const found = new Set<string>()
  mapStrings(abstractZone(value, zoneName), (s) => {
    const l = s.toLowerCase()
    if (needles.some((n) => l.includes(n))) found.add(s)
    return s
  })
  return [...found]
}
