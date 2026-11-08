/** Owned by Security Headers, not Rules. */
export const SECURITY_HEADER_REF_PREFIX = 'zk_sechdr'
export const WIZARD_RULE_REF = `${SECURITY_HEADER_REF_PREFIX}_wizard`

export interface HeaderOption {
  name: string
  help: string
  /** Null leaves it out. */
  values: Record<PresetId, string | null>
}

export type PresetId = 'basic' | 'balanced' | 'strict'

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string; help: string }> = [
  { id: 'basic', label: 'Basic', help: 'Safe for almost every site.' },
  { id: 'balanced', label: 'Balanced', help: 'Adds HSTS and limits browser features.' },
  { id: 'strict', label: 'Strict', help: 'Adds a strict content security policy, test before using.' }
]

export const HEADER_OPTIONS: readonly HeaderOption[] = [
  { name: 'X-Content-Type-Options', help: 'Stops browsers guessing file types.', values: { basic: 'nosniff', balanced: 'nosniff', strict: 'nosniff' } },
  { name: 'X-Frame-Options', help: 'Controls whether other sites can frame your pages.', values: { basic: 'SAMEORIGIN', balanced: 'SAMEORIGIN', strict: 'DENY' } },
  { name: 'Referrer-Policy', help: 'Limits what is sent in the Referer header.', values: { basic: 'strict-origin-when-cross-origin', balanced: 'strict-origin-when-cross-origin', strict: 'no-referrer' } },
  { name: 'Strict-Transport-Security', help: 'Forces HTTPS. Browsers remember this, so it is hard to undo.', values: { basic: null, balanced: 'max-age=31536000', strict: 'max-age=63072000; includeSubDomains; preload' } },
  { name: 'Permissions-Policy', help: 'Limits browser features such as the camera.', values: { basic: null, balanced: 'camera=(), microphone=(), geolocation=()', strict: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' } },
  { name: 'Content-Security-Policy', help: 'Limits where scripts and other content load from.', values: { basic: null, balanced: null, strict: "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" } },
  { name: 'Cross-Origin-Opener-Policy', help: 'Isolates your pages from other windows.', values: { basic: null, balanced: null, strict: 'same-origin' } }
]

export const SINGLE_CHOICES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  'X-Content-Type-Options': [['nosniff', 'nosniff']],
  'X-Frame-Options': [['DENY', 'Deny'], ['SAMEORIGIN', 'Same origin']],
  'Referrer-Policy': [
    ['no-referrer', 'No referrer'],
    ['same-origin', 'Same origin'],
    ['strict-origin', 'Strict origin'],
    ['strict-origin-when-cross-origin', 'Strict origin when cross-origin']
  ],
  'Cross-Origin-Opener-Policy': [['same-origin', 'Same origin'], ['same-origin-allow-popups', 'Allow popups'], ['unsafe-none', 'None']]
}

export const HSTS_AGES: ReadonlyArray<readonly [string, string]> = [['15552000', '6 months'], ['31536000', '1 year'], ['63072000', '2 years']]
export const HSTS_FLAGS: ReadonlyArray<readonly [string, string]> = [['includeSubDomains', 'Include subdomains'], ['preload', 'Preload']]
export const PERMISSION_FEATURES: ReadonlyArray<readonly [string, string]> = [
  ['camera', 'Camera'],
  ['microphone', 'Microphone'],
  ['geolocation', 'Location'],
  ['payment', 'Payment'],
  ['usb', 'USB'],
  ['fullscreen', 'Fullscreen'],
  ['autoplay', 'Autoplay']
]

export function parseHsts(value: string): { age: string | null; flags: string[] } {
  const parts = value.split(';').map((p) => p.trim()).filter(Boolean)
  const age = parts.find((p) => p.startsWith('max-age='))?.slice('max-age='.length) ?? null
  return { age, flags: parts.filter((p) => !p.startsWith('max-age=')) }
}

export function formatHsts(age: string, flags: string[]): string {
  return [`max-age=${age}`, ...HSTS_FLAGS.map(([f]) => f).filter((f) => flags.includes(f))].join('; ')
}

export const parsePermissions = (value: string): string[] =>
  value.split(',').map((p) => p.trim()).filter((p) => p.endsWith('=()')).map((p) => p.slice(0, -'=()'.length))

export const formatPermissions = (features: string[]): string => features.map((f) => `${f}=()`).join(', ')

export function presetValues(id: PresetId): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of HEADER_OPTIONS) {
    const v = h.values[id]
    if (v !== null) out[h.name] = v
  }
  return out
}

export function headersFromRule(rule: Record<string, unknown> | undefined): Record<string, string> {
  const h = (rule?.action_parameters as { headers?: Record<string, { value?: string }> } | undefined)?.headers ?? {}
  return Object.fromEntries(Object.entries(h).flatMap(([k, v]) => (typeof v.value === 'string' ? [[k, v.value]] : [])))
}

export function wizardRule(headers: Record<string, string>): Record<string, unknown> {
  return {
    ref: WIZARD_RULE_REF,
    description: 'Security headers (Zonekeeper)',
    expression: 'true',
    action: 'rewrite',
    enabled: true,
    action_parameters: {
      headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, { operation: 'set', value }]))
    }
  }
}
