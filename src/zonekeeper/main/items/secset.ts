import type { Change, Entry, Profile } from '../../shared/model'
import { resolveZone } from '../../shared/placeholder'
import type { SecurityTxt } from '../../shared/schemas'
import { SECSET_FIELDS } from '../../shared/settingFields'
import { CfApiError, type CfClient, type Zone } from '../cloudflare/client'
import type { ItemAdapter } from '../sync/adapter'
import { orUnavailable } from './rules'
import { createSettingsAdapter } from './settings'

const AREA = 'securitytxt'

export interface SecsetValues {
  [setting: string]: unknown
  security_txt?: SecurityTxt
}

const LIST_FIELDS = ['contact', 'policy', 'encryption', 'acknowledgments', 'canonical', 'hiring'] as const

/** So date format and empty lists don't count as differences. */
export function normalizeSecurityTxt(raw: unknown): SecurityTxt {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = { enabled: r.enabled === true }
  for (const f of LIST_FIELDS) {
    const list = Array.isArray(r[f]) ? (r[f] as unknown[]).map(String).filter(Boolean) : []
    if (list.length > 0) out[f] = list
  }
  if (typeof r.expires === 'string' && r.expires) {
    const d = new Date(r.expires)
    out.expires = Number.isNaN(d.getTime()) ? r.expires : d.toISOString()
  }
  if (typeof r.preferred_languages === 'string' && r.preferred_languages) out.preferred_languages = r.preferred_languages
  return out as unknown as SecurityTxt
}

/** Null if none. */
export async function readSecurityTxt(client: Pick<CfClient, 'get'>, zoneId: string): Promise<SecurityTxt | null> {
  try {
    const r = await client.get<unknown>(`/zones/${zoneId}/security-center/securitytxt`)
    const n = normalizeSecurityTxt(r)
    return n.enabled || Object.keys(n).length > 1 ? n : null
  } catch (e) {
    if (e instanceof CfApiError && e.status === 404) return null
    throw e
  }
}

export const writeSecurityTxt = (client: Pick<CfClient, 'send'>, zoneId: string, value: unknown): Promise<unknown> =>
  client.send('PUT', `/zones/${zoneId}/security-center/securitytxt`, value)

const entry = (value: unknown): Entry => ({ key: 'security_txt', area: AREA, value })
const areaOf = (c: Change): string => ('entry' in c ? c.entry.area : c.actual.area)

export function createSecsetAdapter(): ItemAdapter<SecsetValues> {
  const settings = createSettingsAdapter('secset', SECSET_FIELDS) as unknown as ItemAdapter<SecsetValues>

  const withTxt = async (client: CfClient, zone: Zone, base: { entries: Entry[]; unavailable: string[] }) => {
    const r = await orUnavailable(() => readSecurityTxt(client, zone.id))
    if (r === 'unavailable') return { entries: base.entries, unavailable: [...base.unavailable, AREA] }
    return { entries: r.value ? [...base.entries, entry(r.value)] : base.entries, unavailable: base.unavailable }
  }

  return {
    item: 'secset',

    desired(profile: Profile<SecsetValues>, zone: Zone) {
      const txt = profile.settings.security_txt
      return [...settings.desired(profile, zone), ...(txt ? [entry(normalizeSecurityTxt(resolveZone(txt, zone.name)))] : [])]
    },

    read: async (client, zone, profile) => {
      const base = await settings.read(client, zone, profile)
      return profile.settings.security_txt ? withTxt(client, zone, base) : base
    },
    readForImport: async (client, zone, profile) => withTxt(client, zone, await (settings.readForImport as NonNullable<typeof settings.readForImport>)(client, zone, profile)),

    async apply(client, zone, wanted, changes, unavailable) {
      await settings.apply(client, zone, wanted.filter((e) => e.area !== AREA), changes.filter((c) => areaOf(c) !== AREA), unavailable)
      const txt = wanted.find((e) => e.area === AREA)
      if (txt && !unavailable.includes(AREA) && changes.some((c) => c.type !== 'unchanged' && areaOf(c) === AREA)) await writeSecurityTxt(client, zone.id, txt.value)
    },

    addToProfile(profile, zone, change) {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      if (change.actual.area !== AREA) return settings.addToProfile(profile, zone, change)
      return { ...profile, settings: { ...profile.settings, security_txt: change.actual.value as SecurityTxt } }
    }
  }
}
