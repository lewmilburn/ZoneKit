import type { Change, Entry, Profile } from '../../shared/model'
import { abstractZone, resolveZone } from '../../shared/placeholder'
import type { Rule } from '../../shared/schemas'
import { CACHING_FIELDS } from '../../shared/settingFields'
import type { CfClient, Zone } from '../cloudflare/client'
import type { ItemAdapter } from '../sync/adapter'
import {
  assertRulesUnchangedSince,
  buildPhaseRules,
  orUnavailable,
  ownedRuleEntries,
  ownsRuleEntry,
  PROFILE_REF,
  profileRuleEntries,
  readEntrypoint,
  ruleEntries,
  writeEntrypoint,
  type RawRule
} from './rules'
import { createSettingsAdapter } from './settings'

export const CACHE_PHASE = 'http_request_cache_settings'

export interface CachingValues {
  [setting: string]: unknown
  cacheRules?: Rule[]
}

const ruleEntriesOf = (rules: RawRule[]): Entry[] => ruleEntries(CACHE_PHASE, rules).map((e) => ({ key: e.key, area: e.area, value: e.value, order: e.order }))
const profileRules = (profile: Profile<CachingValues>, zone: Zone): Entry[] =>
  profileRuleEntries(CACHE_PHASE, resolveZone(profile.settings.cacheRules ?? [], zone.name) as RawRule[], profile.id)

const areaOf = (c: Change): string => ('entry' in c ? c.entry.area : c.actual.area)

export function createCachingAdapter(): ItemAdapter<CachingValues> {
  const settings = createSettingsAdapter('caching', CACHING_FIELDS) as unknown as ItemAdapter<CachingValues>

  /** Null `profile` reads every rule, for import. */
  const withRules = async (client: CfClient, zone: Zone, base: { entries: Entry[]; unavailable: string[] }, profile: Profile<CachingValues> | null) => {
    const r = await orUnavailable(() => readEntrypoint(client, `zones/${zone.id}`, CACHE_PHASE))
    if (r === 'unavailable') return { entries: base.entries, unavailable: [...base.unavailable, CACHE_PHASE] }
    const rules = profile ? ownedRuleEntries(CACHE_PHASE, r.value ?? [], profileRules(profile, zone), profile.id) : ruleEntriesOf(r.value ?? [])
    return { entries: [...base.entries, ...rules], unavailable: base.unavailable }
  }

  const desired = (profile: Profile<CachingValues>, zone: Zone): Entry[] => [...settings.desired(profile, zone), ...profileRules(profile, zone)]

  return {
    item: 'caching',
    desired,
    ownsEntry: (e) => e.area === CACHE_PHASE && ownsRuleEntry(e),
    read: async (client, zone, profile) => withRules(client, zone, await settings.read(client, zone, profile), profile),
    readForImport: async (client, zone, profile) => withRules(client, zone, await (settings.readForImport as NonNullable<typeof settings.readForImport>)(client, zone, profile), null),

    async apply(client, zone, wanted, changes, unavailable) {
      await settings.apply(
        client,
        zone,
        wanted.filter((e) => e.area !== CACHE_PHASE),
        changes.filter((c) => areaOf(c) !== CACHE_PHASE),
        unavailable
      )
      if (unavailable.includes(CACHE_PHASE) || !changes.some((c) => c.type !== 'unchanged' && areaOf(c) === CACHE_PHASE)) return
      const scope = `zones/${zone.id}`
      const fresh = await readEntrypoint(client, scope, CACHE_PHASE)
      assertRulesUnchangedSince(changes, CACHE_PHASE, fresh ?? [])
      const rules = wanted.filter((e) => e.area === CACHE_PHASE).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      await writeEntrypoint(client, scope, 'zone', CACHE_PHASE, fresh !== null, buildPhaseRules(CACHE_PHASE, fresh ?? [], rules))
    },

    addToProfile(profile, zone, change) {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      if (change.actual.area !== CACHE_PHASE) return settings.addToProfile(profile, zone, change)
      const { actual } = change
      const list = profile.settings.cacheRules ?? []
      const old = profileRules(profile, zone)
      const key = 'desired' in change ? change.desired.key : actual.key
      const without = list.filter((_, i) => old[i]?.key !== key)
      const at = Math.min(actual.order ?? without.length, without.length)
      const rule = { ...(abstractZone(actual.value, zone.name) as Rule) }
      if (rule.ref?.startsWith(PROFILE_REF)) delete rule.ref
      return { ...profile, settings: { ...profile.settings, cacheRules: [...without.slice(0, at), rule, ...without.slice(at)] } }
    }
  }
}
