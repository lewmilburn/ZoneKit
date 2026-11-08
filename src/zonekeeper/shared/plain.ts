export function isPlain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

/** Safe for a "__proto__" key. */
export function ownObject(entries: Array<[string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) {
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true })
  }
  return out
}
