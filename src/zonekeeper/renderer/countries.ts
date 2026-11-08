/** Not countries. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ'])
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** [code, "Name (code)"] */
export function countryOptions(): Array<readonly [string, string]> {
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })
  const out: Array<readonly [string, string]> = []
  for (const a of LETTERS) {
    for (const b of LETTERS) {
      const code = a + b
      const name = NOT_COUNTRIES.has(code) ? undefined : names.of(code)
      if (name) out.push([code, `${name} (${code})`])
    }
  }
  return out.sort((x, y) => x[1].localeCompare(y[1]))
}
