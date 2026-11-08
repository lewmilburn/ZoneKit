import type { Entry, ItemKind } from '../../shared/model'
import { planLacks, type SettingField } from '../../shared/settingFields'
import { CfApiError, type CfClient, type Zone } from '../cloudflare/client'
import type { ItemAdapter } from '../sync/adapter'
import { orUnavailable } from './rules'

export type ZoneSettingValues = Record<string, string | undefined>

const entry = (id: string, value: string): Entry => ({ key: `setting:${id}`, area: id, value })

const BOT_BOOLEANS = new Set(['fight_mode', 'enable_js', 'is_robots_txt_managed'])
const BOT_FIELDS = new Set([...BOT_BOOLEANS, 'ai_bots_protection', 'crawler_protection'])
const NUMERIC_FIELDS = new Set(['browser_cache_ttl', 'challenge_ttl'])

export async function readZoneSetting(client: CfClient, zone: Zone, id: string): Promise<string> {
  if (BOT_FIELDS.has(id)) {
    const value = (await client.get<Record<string, unknown>>(`/zones/${zone.id}/bot_management`))[id]
    return BOT_BOOLEANS.has(id) ? (value === true ? 'on' : 'off') : String(value)
  }
  if (id === 'tiered_caching') return String((await client.get<{ value: unknown }>(`/zones/${zone.id}/argo/tiered_caching`)).value)
  if (id === 'csam_scanner') {
    const r = await client.get<{ value?: { enabled?: boolean } }>(`/zones/${zone.id}/settings/csam_scanner_third_party`)
    return r.value?.enabled ? 'on' : 'off'
  }
  if (id === 'crawler_hints') {
    // Undocumented endpoint
    try {
      const flags = await client.get<{ cache?: { crawlhints_enabled?: boolean } }>(`/zones/${zone.id}/flags`)
      return flags.cache?.crawlhints_enabled ? 'on' : 'off'
    } catch {
      throw new CfApiError(403, 'Crawler Hints could not be read.')
    }
  }
  const value = (await client.get<{ value: unknown }>(`/zones/${zone.id}/settings/${id}`)).value
  // "zrt" is TLS 1.3 with 0-RTT, which the 0-RTT setting covers
  if (id === 'tls_1_3' && value === 'zrt') return 'on'
  // NEL's value is an object
  if (id === 'nel') return (value as { enabled?: boolean } | null)?.enabled ? 'on' : 'off'
  return String(value)
}

/** One write, as JS Detections can't be off while Bot Fight Mode is on. */
async function writeBotSettings(client: Pick<CfClient, 'send' | 'get'>, zone: Pick<Zone, 'id'>, values: Record<string, string>): Promise<void> {
  // Sends every field, as PUT may reset missing ones
  const { stale_zone_configuration: _stale, using_latest_model: _latest, ...current } = await client.get<Record<string, unknown>>(`/zones/${zone.id}/bot_management`)
  const changes = Object.fromEntries(Object.entries(values).map(([id, v]) => [id, BOT_BOOLEANS.has(id) ? v === 'on' : v]))
  try {
    await client.send('PUT', `/zones/${zone.id}/bot_management`, { ...current, ...changes })
  } catch (e) {
    // Some plans reject extra fields
    if (!(e instanceof CfApiError) || e.status !== 400) throw e
    const core = Object.fromEntries([...BOT_FIELDS].filter((k) => k in current).map((k) => [k, current[k]]))
    const next = { ...core, ...changes }
    try {
      await client.send('PUT', `/zones/${zone.id}/bot_management`, next)
    } catch (retry) {
      if (!(retry instanceof CfApiError)) throw retry
      if (next.fight_mode === true && next.enable_js === false) {
        throw new CfApiError(retry.status, "JavaScript Detections can't be off while Bot Fight Mode is on.", retry.code)
      }
      throw retry
    }
  }
}

export async function writeZoneSetting(client: Pick<CfClient, 'send' | 'get'>, zone: Pick<Zone, 'id'>, id: string, value: string): Promise<void> {
  if (BOT_FIELDS.has(id)) await writeBotSettings(client, zone, { [id]: value })
  else if (id === 'tiered_caching') await client.send('PATCH', `/zones/${zone.id}/argo/tiered_caching`, { value })
  else if (id === 'crawler_hints') await client.send('POST', `/zones/${zone.id}/flags/products/cache/changes`, { feature: 'crawlhints_enabled', value: value === 'on' })
  else if (id === 'csam_scanner') {
    if (value === 'on') {
      const r = await client.get<{ value?: { email?: string } }>(`/zones/${zone.id}/settings/csam_scanner_third_party`)
      if (!r.value?.email) throw new CfApiError(400, 'The CSAM Scanning Tool needs a notification email on this zone first.')
    }
    // Keeps the zone's email
    await client.send('PATCH', `/zones/${zone.id}/settings/csam_scanner_third_party`, { value: { enabled: value === 'on' } })
  } else if (id === 'nel') await client.send('PATCH', `/zones/${zone.id}/settings/nel`, { value: { enabled: value === 'on' } })
  else await client.send('PATCH', `/zones/${zone.id}/settings/${id}`, { value: NUMERIC_FIELDS.has(id) ? Number(value) : value })
}

async function readFields(client: CfClient, zone: Zone, ids: string[]) {
  const entries: Entry[] = []
  const unavailable: string[] = []
  const results = await Promise.all(ids.map((id) => orUnavailable(() => readZoneSetting(client, zone, id))))
  results.forEach((r, i) => {
    const id = ids[i] as string
    if (r === 'unavailable') unavailable.push(id)
    else entries.push(entry(id, r.value))
  })
  return { entries, unavailable }
}

/** Only settings the profile sets are synced. */
export function createSettingsAdapter(item: ItemKind, fields: readonly SettingField[]): ItemAdapter<ZoneSettingValues> {
  const ids = fields.map((f) => f.id)
  // Settings the zone's plan doesn't have are skipped
  const onPlan = (zone: Zone): string[] => fields.filter((f) => !planLacks(f, zone.plan?.name ?? null)).map((f) => f.id)
  return {
    item,
    desired: (profile, zone) => onPlan(zone).flatMap((id) => (profile.settings[id] === undefined ? [] : [entry(id, profile.settings[id] as string)])),
    read: (client, zone, profile) => readFields(client, zone, onPlan(zone).filter((id) => profile.settings[id] !== undefined)),
    readForImport: (client, zone) => readFields(client, zone, onPlan(zone)),

    async apply(client, zone, _desired, changes, unavailable) {
      const label = (id: string): string => fields.find((f) => f.id === id)?.label ?? id
      // Names the failing setting
      const named = async (what: string, work: () => Promise<void>): Promise<void> => {
        try {
          await work()
        } catch (e) {
          if (e instanceof CfApiError) throw new CfApiError(e.status, `${what}: ${e.message}`, e.code)
          throw e
        }
      }
      const bots: Record<string, string> = {}
      const writes: Array<() => Promise<void>> = []
      for (const c of changes) {
        const target = c.type === 'add' ? c.entry : c.type === 'different' ? c.desired : null
        if (!target || unavailable.includes(target.area)) continue
        if (BOT_FIELDS.has(target.area)) bots[target.area] = target.value as string
        else writes.push(() => named(`${label(target.area)} to ${String(target.value)}`, () => writeZoneSetting(client, zone, target.area, target.value as string)))
      }
      if (Object.keys(bots).length > 0) {
        writes.push(() => named(Object.entries(bots).map(([id, v]) => `${label(id)} to ${v}`).join(', '), () => writeBotSettings(client, zone, bots)))
      }
      // Each setting is its own endpoint, so they don't depend on each other
      const results = await Promise.allSettled(writes.map((w) => w()))
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) throw failed.reason
    },

    addToProfile(profile, _zone, change) {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      return { ...profile, settings: { ...profile.settings, [change.actual.area]: change.actual.value as string } }
    }
  }
}
