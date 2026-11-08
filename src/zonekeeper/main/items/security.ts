import type { Entry } from '../../shared/model'
import { abstractZone, resolveZone } from '../../shared/placeholder'
import type { Rule, SecheadSettings, SecuritySettings } from '../../shared/schemas'
import { WIZARD_RULE_REF, headersFromRule, wizardRule } from '../../shared/securityHeaders'
import type { CfClient, Zone } from '../cloudflare/client'
import type { ItemAdapter } from '../sync/adapter'
import {
  assertRulesUnchangedSince,
  assertUnchangedSince,
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

export const FIREWALL = 'http_request_firewall_custom'
export const HEADERS = 'http_response_headers_transform'

const changed = (changes: Parameters<ItemAdapter<unknown>['apply']>[3], area: string): boolean =>
  changes.some((c) => c.type !== 'unchanged' && ('entry' in c ? c.entry.area === area : c.actual.area === area || ('desired' in c && c.desired.area === area)))

export function createSecurityAdapter(): ItemAdapter<SecuritySettings> {
  const adapter: ItemAdapter<SecuritySettings> = {
    item: 'security',

    desired: (profile, zone) => profileRuleEntries(FIREWALL, resolveZone(profile.settings, zone.name).firewall as RawRule[], profile.id),
    ownsEntry: ownsRuleEntry,

    // Profile rules only
    async read(client: CfClient, zone: Zone, profile) {
      const fw = await orUnavailable(() => readEntrypoint(client, `zones/${zone.id}`, FIREWALL))
      if (fw === 'unavailable') return { entries: [], unavailable: [FIREWALL] }
      return { entries: ownedRuleEntries(FIREWALL, fw.value ?? [], adapter.desired(profile, zone), profile.id), unavailable: [] }
    },
    // Import takes every rule
    async readForImport(client: CfClient, zone: Zone) {
      const fw = await orUnavailable(() => readEntrypoint(client, `zones/${zone.id}`, FIREWALL))
      if (fw === 'unavailable') return { entries: [], unavailable: [FIREWALL] }
      return { entries: ruleEntries(FIREWALL, fw.value ?? []).map((e) => ({ key: e.key, area: e.area, value: e.value, order: e.order })), unavailable: [] }
    },

    async apply(client, zone, desired, changes, unavailable) {
      if (unavailable.includes(FIREWALL) || !changed(changes, FIREWALL)) return
      const scope = `zones/${zone.id}`
      const fresh = await readEntrypoint(client, scope, FIREWALL)
      assertRulesUnchangedSince(changes, FIREWALL, fresh ?? [])
      const wanted = [...desired].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      await writeEntrypoint(client, scope, 'zone', FIREWALL, fresh !== null, buildPhaseRules(FIREWALL, fresh ?? [], wanted))
    },

    addToProfile(profile, zone, change) {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      const { actual } = change
      const value = { ...(abstractZone(actual.value, zone.name) as Rule) }
      if (value.ref?.startsWith(PROFILE_REF)) delete value.ref
      const s = profile.settings
      const old = adapter.desired(profile, zone)
      const key = 'desired' in change ? change.desired.key : actual.key
      const without = s.firewall.filter((_, i) => old[i]?.key !== key)
      const at = Math.min(actual.order ?? without.length, without.length)
      return { ...profile, settings: { ...s, firewall: [...without.slice(0, at), value, ...without.slice(at)] } }
    }
  }
  return adapter
}

const headerEntry = (name: string, value: string): Entry => ({ key: `header:${name.toLowerCase()}`, area: HEADERS, value: { name, value } })

/** One entry per header, written as a single rule. */
export function createSecheadAdapter(): ItemAdapter<SecheadSettings> {
  const own = (rules: RawRule[]): RawRule | undefined => rules.find((r) => r.ref === WIZARD_RULE_REF)
  const entriesOf = (rules: RawRule[]): Entry[] => Object.entries(headersFromRule(own(rules))).map(([n, v]) => headerEntry(n, v))
  return {
    item: 'sechead',
    desired: (profile) => Object.entries(profile.settings.headers).map(([n, v]) => headerEntry(n, v)),

    async read(client, zone) {
      const r = await orUnavailable(() => readEntrypoint(client, `zones/${zone.id}`, HEADERS))
      return r === 'unavailable' ? { entries: [], unavailable: [HEADERS] } : { entries: entriesOf(r.value ?? []), unavailable: [] }
    },

    async apply(client, zone, desired, changes, unavailable) {
      if (unavailable.includes(HEADERS) || !changed(changes, HEADERS)) return
      const scope = `zones/${zone.id}`
      const fresh = await readEntrypoint(client, scope, HEADERS)
      assertUnchangedSince(changes, HEADERS, entriesOf(fresh ?? []))
      const kept = (fresh ?? []).filter((r) => r.ref !== WIZARD_RULE_REF).map((r) => {
        const { version: _v, last_updated: _l, ...rest } = r
        return rest
      })
      const headers = Object.fromEntries(desired.map((e) => {
        const v = e.value as { name: string; value: string }
        return [v.name, v.value]
      }))
      await writeEntrypoint(client, scope, 'zone', HEADERS, fresh !== null, Object.keys(headers).length > 0 ? [...kept, wizardRule(headers)] : kept)
    },

    addToProfile(profile, _zone, change) {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      const v = change.actual.value as { name: string; value: string }
      return { ...profile, settings: { headers: { ...profile.settings.headers, [v.name]: v.value } } }
    }
  }
}
