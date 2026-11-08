import { z } from 'zod'
import type {
  IpcResult,
  RuleCounts,
  ZonePhaseView,
  ZoneRulesView,
  ZoneRuleView
} from '../shared/ipc'
import type { Profile } from '../shared/model'
import { MANAGED_WWW_REF_PREFIX, RULES_PHASES, findForbiddenKey, type RulesSettings } from '../shared/schemas'
import { CfApiError, type CfClient, type Zone } from './cloudflare/client'
import { UserError } from './errors'
import { resolveZone } from '../shared/placeholder'
import type { SecuritySettings } from '../shared/schemas'
import { hash, matchesRule, PROFILE_REF, profileRuleEntries, ruleEntries, type RawRule } from './items/rules'
import { FIREWALL } from './items/security'
import type { ItemAdapter } from './sync/adapter'

export interface ZoneRulesDeps {
  client: Pick<CfClient, 'get' | 'send' | 'listZones'>
  store: { list(item: 'rules' | 'security' | 'caching'): Promise<Profile<unknown>[]> }
  adapter: Pick<ItemAdapter<RulesSettings>, 'desired'>
}

import { errorText } from '../shared/errorText'

const CACHE_PHASE = 'http_request_cache_settings'
const ZONE_PHASES = [...RULES_PHASES, CACHE_PHASE] as const
const ID = /^[A-Za-z0-9_-]{1,64}$/
const idSchema = z.string().regex(ID)
const getSchema = idSchema
const saveSchema = z.strictObject({
  zoneId: idSchema,
  phase: z.enum(ZONE_PHASES),
  ruleId: idSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  description: z.string().max(500),
  expression: z.string().min(1).max(4096),
  enabled: z.boolean(),
  actionParameters: z.record(z.string(), z.unknown()).optional(),
  confirmed: z.literal(true)
})

const deleteSchema = z.strictObject({
  zoneId: idSchema,
  phase: z.enum(ZONE_PHASES),
  ruleId: idSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  confirmed: z.literal(true)
})

const createSchema = z.strictObject({
  zoneId: z.string().regex(ID),
  phase: z.enum(ZONE_PHASES),
  rule: z.strictObject({
    description: z.string().max(500).optional(),
    expression: z.string().min(1).max(4096),
    action: z.enum(['block', 'managed_challenge', 'js_challenge', 'challenge', 'log', 'redirect', 'rewrite', 'set_cache_settings']),
    action_parameters: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean()
  }),
  confirmed: z.literal(true)
})

const BAD = 'That request was not valid.'
const RELOAD = 'This rule changed in Cloudflare, reload and try again.'

interface Ruleset {
  id: string
  rules: RawRule[]
}

interface Context {
  zone: Zone
  profileName: string | null
  managed: Set<string>
  securityManaged?: Set<string>
  securityName?: string
  /** Shows rules not synced yet. */
  wanted: Array<{ key: string; area: string; value: unknown; profile: string }>
}

function describe(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof CfApiError) {
    if (e.status === 403) return "Your token can't write this."
    if (e.status === 401) return 'Cloudflare rejected your API token.'
    if (e.status === 0) return "Couldn't reach Cloudflare, check your connection."
    return `Cloudflare refused this: ${errorText(e)}`
  }
  return errorText(e)
}

export function createRuleCountHandler(client: ZoneRulesDeps['client']) {
  return async (raw: unknown): Promise<IpcResult<RuleCounts>> => {
    const id = idSchema.safeParse(raw)
    if (!id.success) return { ok: false, error: BAD }
    try {
      const sets = await Promise.all(ZONE_PHASES.map(async (p) => [p, await readRuleset(client, id.data, p)] as const))
      const count = (s: Ruleset | null | 'unavailable'): number => (s && s !== 'unavailable' ? s.rules.length : 0)
      return {
        ok: true,
        value: {
          waf: sets.filter(([p]) => p === FIREWALL).reduce((n, [, s]) => n + count(s), 0),
          rules: sets.filter(([p]) => p !== FIREWALL).reduce((n, [, s]) => n + count(s), 0)
        }
      }
    } catch (e) {
      return { ok: false, error: describe(e) }
    }
  }
}

/** Null: no ruleset yet. */
async function readRuleset(client: ZoneRulesDeps['client'], zoneId: string, phase: string): Promise<Ruleset | null | 'unavailable'> {
  let r: unknown
  try {
    r = await client.get(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`)
  } catch (e) {
    if (e instanceof CfApiError && e.status === 404) return null
    if (e instanceof CfApiError && e.status === 403) return 'unavailable'
    throw e
  }
  const o = r as { id?: unknown; rules?: unknown } | null
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !ID.test(o.id) || (o.rules !== undefined && !Array.isArray(o.rules))) {
    throw new UserError(`Cloudflare returned an unexpected ruleset for ${phase}.`)
  }
  return { id: o.id, rules: (o.rules as RawRule[] | undefined) ?? [] }
}

async function loadContext(deps: ZoneRulesDeps, zoneId: string): Promise<Context> {
  const zone = (await deps.client.listZones()).find((z) => z.id === zoneId)
  if (!zone) throw new UserError('That zone was not found for this token.')
  const secs = (await deps.store.list('security')).filter((p) => p.item === 'security' && p.zoneIds.includes(zoneId)) as Profile<SecuritySettings>[]
  const security =
    secs.length > 0
      ? {
          securityName: secs.map((p) => p.name).join(', '),
          securityManaged: new Set(secs.flatMap((p) => ruleEntries(FIREWALL, resolveZone(p.settings, zone.name).firewall as RawRule[]).map((e) => e.key)))
        }
      : {}
  const wanted: Context['wanted'] = secs.flatMap((p) =>
    profileRuleEntries(FIREWALL, resolveZone(p.settings, zone.name).firewall as RawRule[], p.id).map((e) => ({ key: e.key, area: e.area, value: e.value, profile: p.name }))
  )
  for (const p of (await deps.store.list('caching')).filter((x) => x.item === 'caching' && x.zoneIds.includes(zoneId))) {
    const rules = resolveZone((p.settings as { cacheRules?: RawRule[] }).cacheRules ?? [], zone.name)
    for (const e of profileRuleEntries(CACHE_PHASE, rules, p.id)) wanted.push({ key: e.key, area: e.area, value: e.value, profile: p.name })
  }
  const profiles = (await deps.store.list('rules')).filter((p) => p.zoneIds.includes(zoneId))
  if (profiles.length === 0) return { zone, profileName: null, managed: new Set(), wanted, ...security }
  const managed = new Set<string>()
  for (const profile of profiles) {
    try {
      for (const e of deps.adapter.desired(profile as Profile<RulesSettings>, zone)) {
        managed.add(e.key)
        wanted.push({ key: e.key, area: e.area, value: e.value, profile: profile.name })
      }
    } catch (e) {
      throw new UserError(`The Rules profile "${profile.name}" could not be resolved for this zone, so rules can't be shown: ${describe(e)}`)
    }
  }
  return { zone, profileName: profiles.map((p) => p.name).join(', '), managed, wanted, ...security }
}

/** Null if editable. */
function readOnlyNote(ctx: Context, phase: string, rules: RawRule[], rule: RawRule): string | null {
  if (typeof rule.ref === 'string' && rule.ref.startsWith(MANAGED_WWW_REF_PREFIX)) return 'Managed by the WWW tab'
  const owner = ctx.wanted.find((w) => w.area === phase && matchesRule(w, rule))
  if (owner) return `Managed by profile ${owner.profile}`
  if (typeof rule.ref === 'string' && rule.ref.startsWith(PROFILE_REF)) return 'Left by a profile this zone is no longer in.'
  return null
}

function toView(ctx: Context, phase: string, rules: RawRule[], rule: RawRule): ZoneRuleView {
  return {
    id: String(rule.id),
    ref: typeof rule.ref === 'string' ? rule.ref : null,
    description: typeof rule.description === 'string' ? rule.description : '',
    expression: String(rule.expression ?? ''),
    action: String(rule.action ?? ''),
    enabled: rule.enabled ?? true,
    actionParameters: rule.action_parameters ?? null,
    fingerprint: hash(rule),
    readOnlyNote: readOnlyNote(ctx, phase, rules, rule)
  }
}

async function buildView(deps: ZoneRulesDeps, zoneId: string): Promise<ZoneRulesView> {
  const ctx = await loadContext(deps, zoneId)
  const phases: ZonePhaseView[] = []
  for (const phase of ZONE_PHASES) {
    const rs = await readRuleset(deps.client, zoneId, phase)
    if (rs === 'unavailable') phases.push({ phase, status: 'unavailable', rules: [] })
    else {
      const rules = (rs?.rules ?? []).filter((r) => typeof r.id === 'string')
      const notSynced = ctx.wanted
        .filter((w) => w.area === phase && !rules.some((r) => matchesRule(w, r)))
        .map((w): ZoneRuleView => {
          const v = w.value as { ref?: unknown; description?: unknown; expression?: unknown; action?: unknown; enabled?: boolean; action_parameters?: unknown }
          return {
            id: `profile:${w.key}`,
            ref: typeof v.ref === 'string' ? v.ref : null,
            description: typeof v.description === 'string' ? v.description : '',
            expression: String(v.expression ?? ''),
            action: String(v.action ?? ''),
            enabled: v.enabled ?? true,
            actionParameters: v.action_parameters ?? null,
            fingerprint: hash(w.value),
            readOnlyNote: `In profile ${w.profile}, not synced yet.`
          }
        })
      phases.push({ phase, status: 'ok', rules: [...rules.map((r) => toView(ctx, phase, rules, r)), ...notSynced] })
    }
  }
  return { zoneId, zoneName: ctx.zone.name, profileName: ctx.profileName, phases }
}

export function createZoneRulesHandlers(deps: ZoneRulesDeps) {
  return {
    async get(raw: unknown): Promise<IpcResult<ZoneRulesView>> {
      const id = getSchema.safeParse(raw)
      if (!id.success) return { ok: false, error: BAD }
      try {
        return { ok: true, value: await buildView(deps, id.data) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async create(raw: unknown): Promise<IpcResult<ZoneRulesView>> {
      const input = createSchema.safeParse(raw)
      if (!input.success || findForbiddenKey(input.data.rule)) return { ok: false, error: BAD }
      const i = input.data
      try {
        if (JSON.stringify(i.rule).length > 100_000) return { ok: false, error: BAD }
        const rs = await readRuleset(deps.client, i.zoneId, i.phase)
        if (rs === 'unavailable') throw new UserError("Your token can't read this.")
        if (rs) await deps.client.send('POST', `/zones/${i.zoneId}/rulesets/${rs.id}/rules`, i.rule)
        else await deps.client.send('POST', `/zones/${i.zoneId}/rulesets`, { name: `Zonekeeper ${i.phase}`, kind: 'zone', phase: i.phase, rules: [i.rule] })
        return { ok: true, value: await buildView(deps, i.zoneId) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async save(raw: unknown): Promise<IpcResult<ZoneRulesView>> {
      const input = saveSchema.safeParse(raw)
      if (!input.success || (input.data.actionParameters !== undefined && findForbiddenKey(input.data.actionParameters))) {
        return { ok: false, error: BAD }
      }
      const i = input.data
      try {
        if (JSON.stringify(i.actionParameters ?? {}).length > 100_000) return { ok: false, error: BAD }
        const ctx = await loadContext(deps, i.zoneId)
        const rs = await readRuleset(deps.client, i.zoneId, i.phase)
        if (rs === 'unavailable') throw new UserError("Your token can't read this.")
        const rule = rs?.rules.find((r) => r.id === i.ruleId)
        if (!rs || !rule) throw new UserError(RELOAD)
        const note = readOnlyNote(ctx, i.phase, rs.rules, rule)
        if (note) throw new UserError(`${note}.`)
        if (hash(rule) !== i.fingerprint) throw new UserError(RELOAD)

        const { id: _id, version: _v, last_updated: _l, ...kept } = rule
        const body: Record<string, unknown> = { ...kept, description: i.description, expression: i.expression, enabled: i.enabled }
        if (i.actionParameters !== undefined) body.action_parameters = i.actionParameters
        // Single-rule endpoint: keeps its position
        await deps.client.send('PATCH', `/zones/${i.zoneId}/rulesets/${rs.id}/rules/${i.ruleId}`, body)
        return { ok: true, value: await buildView(deps, i.zoneId) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async remove(raw: unknown): Promise<IpcResult<ZoneRulesView>> {
      const input = deleteSchema.safeParse(raw)
      if (!input.success) return { ok: false, error: BAD }
      const i = input.data
      try {
        const ctx = await loadContext(deps, i.zoneId)
        const rs = await readRuleset(deps.client, i.zoneId, i.phase)
        if (rs === 'unavailable') throw new UserError("Your token can't read this.")
        const rule = rs?.rules.find((r) => r.id === i.ruleId)
        if (!rs || !rule || hash(rule) !== i.fingerprint) throw new UserError(RELOAD)
        const note = readOnlyNote(ctx, i.phase, rs.rules, rule)
        if (note) throw new UserError(`${note}.`)
        await deps.client.send('DELETE', `/zones/${i.zoneId}/rulesets/${rs.id}/rules/${i.ruleId}`)
        return { ok: true, value: await buildView(deps, i.zoneId) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
