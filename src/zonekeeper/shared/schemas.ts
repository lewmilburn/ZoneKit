import { z } from 'zod'
import type { ItemKind, Profile } from './model'
import { isPlain } from './plain'

export const FORMAT_VERSION = 1
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024

export const ITEM_KINDS = ['security', 'sechead', 'secset', 'speed', 'rules', 'email', 'www', 'ssl', 'caching', 'network', 'compliance'] as const satisfies readonly ItemKind[]

const plainObject = z.custom<Record<string, unknown>>((v) => isPlain(v), 'settings must be a JSON object')

/** Unregistered items only need a plain object. */
const settingsSchemas = new Map<ItemKind, z.ZodType<unknown>>()

export function registerSettingsSchema(item: ItemKind, schema: z.ZodType<unknown>): void {
  settingsSchemas.set(item, schema)
}

export function settingsSchemaFor(item: ItemKind): z.ZodType<unknown> {
  return settingsSchemas.get(item) ?? plainObject
}

/** URL rewrites aren't managed. */
export const RULES_PHASES = [
  'http_request_firewall_custom',
  'http_request_dynamic_redirect',
  'http_request_late_transform',
  'http_response_headers_transform'
] as const
export type RulesPhase = (typeof RULES_PHASES)[number]

/** Owned by the WWW tab, Rules sync never touches them. */
export const MANAGED_WWW_REF_PREFIX = 'zonekeeper-www'

const ruleSchema = z.looseObject({
  expression: z.string().min(1),
  action: z.string().min(1),
  ref: z.string().min(1).optional(),
  enabled: z.boolean().optional()
})
export type Rule = z.infer<typeof ruleSchema>

const pageRuleSchema = z.strictObject({
  targets: z.array(z.looseObject({})),
  actions: z.array(z.looseObject({ id: z.string().min(1) })),
  status: z.enum(['active', 'disabled']).optional()
})
export type PageRule = z.infer<typeof pageRuleSchema>

const bulkRedirectSchema = z.strictObject({
  redirect: z.strictObject({
    source_url: z.string().min(1),
    target_url: z.string().min(1),
    status_code: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional(),
    include_subdomains: z.boolean().optional(),
    subpath_matching: z.boolean().optional(),
    preserve_query_string: z.boolean().optional(),
    preserve_path_suffix: z.boolean().optional()
  }),
  comment: z.string().optional()
})
export type BulkRedirect = z.infer<typeof bulkRedirectSchema>

const phaseRules = z.array(ruleSchema)

export const rulesSettingsSchema = z
  .strictObject({
    phases: z.strictObject({
      http_request_firewall_custom: phaseRules,
      http_request_dynamic_redirect: phaseRules,
      http_request_late_transform: phaseRules,
      http_response_headers_transform: phaseRules
    }),
    pageRules: z.array(pageRuleSchema),
    bulkRedirects: z.array(bulkRedirectSchema),
    /** Unset: Bulk Redirects aren't managed. */
    bulkRedirectList: z.string().regex(/^[a-z0-9_]{1,50}$/).optional()
  })
  .superRefine((s, ctx) => {
    if (s.bulkRedirects.length > 0 && s.bulkRedirectList === undefined) {
      ctx.addIssue({ code: 'custom', path: ['bulkRedirectList'], message: 'Name the list these redirects belong to' })
    }
    for (const phase of RULES_PHASES) {
      s.phases[phase].forEach((r, i) => {
        if (r.ref?.startsWith(MANAGED_WWW_REF_PREFIX)) {
          ctx.addIssue({ code: 'custom', path: ['phases', phase, i, 'ref'], message: 'This ref is reserved for the WWW item' })
        }
        const params = r.action_parameters as { uri?: unknown } | undefined
        if (phase.endsWith('_transform') && params?.uri !== undefined) {
          ctx.addIssue({ code: 'custom', path: ['phases', phase, i, 'action_parameters', 'uri'], message: 'URL rewrites are not managed by this item' })
        }
      })
    }
  })
export type RulesSettings = z.infer<typeof rulesSettingsSchema>

registerSettingsSchema('rules', rulesSettingsSchema)

export const securitySettingsSchema = z.object({ firewall: phaseRules })
export type SecuritySettings = z.infer<typeof securitySettingsSchema>
registerSettingsSchema('security', securitySettingsSchema)

export const secheadSettingsSchema = z.strictObject({ headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().min(1).max(4000)) })
export type SecheadSettings = z.infer<typeof secheadSettingsSchema>
registerSettingsSchema('sechead', secheadSettingsSchema)

const mxList = z.array(z.strictObject({ content: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'must be a host name'), priority: z.number().int().min(0).max(65535) }))
/** `from` is the local part, or `*` for catch-all. */
const routeList = z.array(z.strictObject({ from: z.string().regex(/^(\*|[a-z0-9._+-]{1,64})$/, 'must be the part before the @, or *'), to: z.string().email().max(254) }))

/** The mail server part of an Email profile. */
export const mailSettingsSchema = z.strictObject({ mx: mxList, routes: routeList.optional() })
export type MailSettings = z.infer<typeof mailSettingsSchema>

const optionOf = <const T extends string>(values: readonly T[]) => z.enum(values as unknown as [T, ...T[]]).optional()
export const sslSettingsSchema = z.strictObject({
  ssl: optionOf(['off', 'flexible', 'full', 'strict']),
  min_tls_version: optionOf(['1.0', '1.1', '1.2', '1.3']),
  // 0-RTT is the Speed profile's
  tls_1_3: optionOf(['on', 'off']),
  always_use_https: optionOf(['on', 'off']),
  automatic_https_rewrites: optionOf(['on', 'off']),
  opportunistic_encryption: optionOf(['on', 'off']),
  tls_client_auth: optionOf(['on', 'off'])
})
registerSettingsSchema('ssl', sslSettingsSchema)

export const cachingSettingsSchema = z.strictObject({
  cache_level: optionOf(['basic', 'simplified', 'aggressive']),
  browser_cache_ttl: optionOf(['0', '1800', '14400', '86400', '604800', '2592000', '31536000']),
  crawler_hints: optionOf(['on', 'off']),
  always_online: optionOf(['on', 'off']),
  tiered_caching: optionOf(['on', 'off']),
  sort_query_string_for_cache: optionOf(['on', 'off']),
  cacheRules: phaseRules.optional()
})
registerSettingsSchema('caching', cachingSettingsSchema)

export const speedSettingsSchema = z.strictObject({
  rocket_loader: optionOf(['on', 'off']),
  early_hints: optionOf(['on', 'off']),
  brotli: optionOf(['on', 'off']),
  http2: optionOf(['on', 'off']),
  http3: optionOf(['on', 'off']),
  '0rtt': optionOf(['on', 'off']),
  polish: optionOf(['off', 'lossless', 'lossy']),
  speed_brain: optionOf(['on', 'off']),
  fonts: optionOf(['on', 'off']),
  h2_prioritization: optionOf(['on', 'off', 'custom']),
  origin_max_http_version: optionOf(['1', '2'])
})
registerSettingsSchema('speed', speedSettingsSchema)

export const networkSettingsSchema = z.strictObject({
  ipv6: optionOf(['on', 'off']),
  websockets: optionOf(['on', 'off']),
  pseudo_ipv4: optionOf(['off', 'add_header', 'overwrite_header']),
  ip_geolocation: optionOf(['on', 'off']),
  nel: optionOf(['on', 'off']),
  opportunistic_onion: optionOf(['on', 'off']),
  true_client_ip_header: optionOf(['on', 'off'])
})
registerSettingsSchema('network', networkSettingsSchema)

export const complianceSettingsSchema = z.strictObject({ csam_scanner: optionOf(['on', 'off']) })
registerSettingsSchema('compliance', complianceSettingsSchema)

const textList = z.array(z.string().min(1).max(2000)).max(50)
export const securityTxtSchema = z
  .strictObject({
    enabled: z.boolean(),
    contact: textList.optional(),
    expires: z.string().max(50).optional(),
    policy: textList.optional(),
    encryption: textList.optional(),
    acknowledgments: textList.optional(),
    canonical: textList.optional(),
    hiring: textList.optional(),
    preferred_languages: z.string().max(200).optional()
  })
  .superRefine((t, ctx) => {
    if (t.expires && Number.isNaN(new Date(t.expires).getTime())) ctx.addIssue({ code: 'custom', path: ['expires'], message: 'must be a date, such as 2027-01-31' })
    if (!t.enabled) return
    if (!t.contact || t.contact.length === 0) ctx.addIssue({ code: 'custom', path: ['contact'], message: 'security.txt needs at least one contact' })
    if (!t.expires) ctx.addIssue({ code: 'custom', path: ['expires'], message: 'security.txt needs an expiry date' })
  })
export type SecurityTxt = z.infer<typeof securityTxtSchema>

export const secsetSettingsSchema = z.strictObject({
  security_txt: securityTxtSchema.optional(),
  security_level: optionOf(['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack']),
  challenge_ttl: optionOf(['900', '1800', '3600', '14400', '86400', '604800', '2592000']),
  browser_check: optionOf(['on', 'off']),
  email_obfuscation: optionOf(['on', 'off']),
  hotlink_protection: optionOf(['on', 'off']),
  server_side_exclude: optionOf(['on', 'off']),
  ai_bots_protection: optionOf(['disabled', 'only_on_ad_pages', 'block']),
  crawler_protection: optionOf(['enabled', 'disabled']),
  is_robots_txt_managed: optionOf(['on', 'off']),
  fight_mode: optionOf(['on', 'off']),
  enable_js: optionOf(['on', 'off'])
})
registerSettingsSchema('secset', secsetSettingsSchema)

const SPF_PATTERN = /^v=spf1(?![A-Za-z0-9])/i
const DMARC_PATTERN = /^v=DMARC1(?![A-Za-z0-9])/i
/** Shared with the adapter so reads match. */
export const isSpfValue = (s: string): boolean => SPF_PATTERN.test(s.trimStart())
export const isDmarcValue = (s: string): boolean => DMARC_PATTERN.test(s.trimStart())

const noControlChars = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s)
const txtValue = z.string().min(1).max(4000).refine(noControlChars, 'must not contain control characters')
/** 1 is automatic, else 60-86400s. */
const ttl = z.number().int().max(86400).refine((v) => v === 1 || v >= 60, 'must be 1 (automatic) or 60 to 86400')

const dkimRecordSchema = z
  .strictObject({
    /** Case-insensitive. */
    selector: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/, 'must be one DNS label of letters, digits, _ or -'),
    type: z.enum(['TXT', 'CNAME']),
    mode: z.enum(['shared', 'perZone']),
    value: z.string().min(1).max(4000).optional(),
    /** By zone ID. Zones without one can't sync. */
    perZone: z.record(z.string().min(1), txtValue).optional(),
    ttl: ttl.optional()
  })
  .superRefine((r, ctx) => {
    if (r.mode === 'shared') {
      if (r.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'A shared record needs a value' })
      if (r.perZone !== undefined) ctx.addIssue({ code: 'custom', path: ['perZone'], message: 'A shared record has no per-zone values' })
    } else {
      if (r.value !== undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'A per-zone record has no shared value' })
      if (r.perZone === undefined) ctx.addIssue({ code: 'custom', path: ['perZone'], message: 'A per-zone record needs its per-zone values' })
    }
    const values = r.mode === 'shared' ? [r.value] : Object.values(r.perZone ?? {})
    if (r.type === 'CNAME' && values.some((v) => v !== undefined && (/\s/.test(v) || v.length > 255))) {
      ctx.addIssue({ code: 'custom', path: [r.mode === 'shared' ? 'value' : 'perZone'], message: 'A CNAME target must be a host name with no spaces' })
    }
    if (r.value !== undefined && !noControlChars(r.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'must not contain control characters' })
    }
  })
export type DkimRecord = z.infer<typeof dkimRecordSchema>

export const emailSettingsSchema = z
  .strictObject({
    /** Null: not managed. */
    spf: txtValue.refine(isSpfValue, 'must start with v=spf1').nullable(),
    dmarc: txtValue.nullable(),
    /** CNAME: `dmarc` is a host, as some mail providers offer. */
    dmarcType: z.enum(['TXT', 'CNAME']).optional(),
    dkim: z.array(dkimRecordSchema),
    /** Unset keeps the zone's TTL. */
    spfTtl: ttl.optional(),
    dmarcTtl: ttl.optional(),
    /** Unset: mail servers aren't managed. */
    mx: mxList.optional(),
    routes: routeList.optional(),
    /** Cloudflare's DMARC Management, which adds its own report address. */
    dmarcReports: z.literal('cloudflare').optional(),
    /** Where TLS failure reports go, unset: not managed. */
    tlsRpt: z.string().email().max(254).optional(),
    /** Unset: not managed. */
    bimi: z
      .strictObject({
        logo: z.string().max(2000).regex(/^https:\/\/[^\s;]+\.svg$/i, 'must be an https link to an SVG'),
        /** Verified Mark Certificate, which Gmail needs to show the logo. */
        vmc: z.string().max(2000).regex(/^https:\/\/[^\s;]+\.pem$/i, 'must be an https link to a .pem file').optional()
      })
      .optional()
  })
  .superRefine((s, ctx) => {
    if (s.dmarc !== null) {
      if (s.dmarcType === 'CNAME') {
        if (/\s/.test(s.dmarc) || s.dmarc.length > 255) ctx.addIssue({ code: 'custom', path: ['dmarc'], message: 'A CNAME target must be a host name with no spaces' })
      } else if (!isDmarcValue(s.dmarc)) {
        ctx.addIssue({ code: 'custom', path: ['dmarc'], message: 'must start with v=DMARC1' })
      }
    }
    const seen = new Set<string>()
    s.dkim.forEach((r, i) => {
      const sel = r.selector.toLowerCase()
      if (seen.has(sel)) ctx.addIssue({ code: 'custom', path: ['dkim', i, 'selector'], message: 'Each selector can appear only once' })
      seen.add(sel)
    })
  })
export type EmailSettings = z.infer<typeof emailSettingsSchema>

registerSettingsSchema('email', emailSettingsSchema)

const FORBIDDEN_KEYS =new Set(['__proto__', 'constructor', 'prototype'])

/** Iterative, so deep JSON can't overflow the stack. */
export function findForbiddenKey(root: unknown): string | undefined {
  const stack: Array<[unknown, string]> = [[root, '$']]
  while (stack.length > 0) {
    const [node, path] = stack.pop()!
    if (node === null || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      node.forEach((v, i) => stack.push([v, `${path}[${i}]`]))
      continue
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.has(key)) return `${path}.${key}`
      stack.push([(node as Record<string, unknown>)[key], `${path}.${key}`])
    }
  }
  return undefined
}

export const profileSchema = z
  .strictObject({
    id: z.string().min(1).max(200),
    item: z.enum(ITEM_KINDS),
    name: z.string().min(1).max(500),
    version: z.number().int().min(1),
    zoneIds: z
      .array(z.string().min(1).max(100))
      .refine((ids) => new Set(ids).size === ids.length, 'zoneIds contains duplicates'),
    settings: z.unknown(),
    updatedAt: z.string().min(1).max(100)
  })
  .superRefine((p, ctx) => {
    const r = settingsSchemaFor(p.item).safeParse(p.settings)
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({ code: 'custom', path: ['settings', ...issue.path], message: issue.message })
      }
    }
  })

export const importEnvelopeSchema = z.strictObject({
  formatVersion: z.number().int().min(1),
  profiles: z.array(z.unknown()),
  /** Child zone id to parent zone id. */
  parentLinks: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).optional()
})

export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
    .join('; ')
}

/** Throws a readable Error. */
export function parseProfile(input: unknown): Profile<unknown> {
  const forbidden = findForbiddenKey(input)
  if (forbidden) throw new Error(`Invalid profile: forbidden key (${forbidden})`)
  const r = profileSchema.safeParse(input)
  if (!r.success) throw new Error(`Invalid profile: ${describeIssues(r.error)}`)
  return r.data as Profile<unknown>
}
