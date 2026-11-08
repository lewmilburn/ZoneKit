import type { Entry } from '../../shared/model'
import type { MailSettings } from '../../shared/schemas'
import { MAIL_PROVIDERS } from '../../shared/mailProviders'
import type { CfClient, Zone } from '../cloudflare/client'
import type { ItemAdapter } from '../sync/adapter'
import { assertUnchangedSince, orUnavailable } from './rules'

const AREA = 'mx'
interface RawMx { id: string; name: string; type: string; content: string; priority?: number }

const host = (s: string): string => s.trim().replace(/\.$/, '').toLowerCase()
const entry = (content: string, priority: number): Entry => ({ key: `mx:${host(content)}`, area: AREA, value: { content: host(content), priority } })

async function readMx(client: CfClient, zone: Zone): Promise<RawMx[]> {
  const qs = new URLSearchParams({ type: 'MX', per_page: '100' })
  const { result } = await client.getPage<RawMx[]>(`/zones/${zone.id}/dns_records?${qs}`)
  return result.filter((r) => r.type === 'MX' && r.name.toLowerCase() === zone.name.toLowerCase())
}

const ROUTING = 'routing'
const CATCH_ALL = '*'
interface RawRule {
  id: string
  enabled?: boolean
  matchers?: { type: string; field?: string; value?: string }[]
  actions?: { type: string; value?: string[] }[]
}
const route = (from: string, to: string): Entry => ({ key: `route:${from.toLowerCase()}`, area: ROUTING, value: { to: to.toLowerCase() } })
// Email Routing switched on, which creates its MX records
const ROUTING_ON: Entry = { key: 'routing:on', area: ROUTING, value: true }
const isRoutingMx = (content: string): boolean => host(content).endsWith('.mx.cloudflare.net')
const isCloudflareMx = (mx: RawMx[]): boolean => mx.some((m) => isRoutingMx(m.content))

/** One address to one destination, other rules are left alone. */
function simpleForward(r: RawRule, zone: Zone): { from: string; to: string } | null {
  const m = r.matchers ?? []
  const a = r.actions ?? []
  if (r.enabled === false || m.length !== 1 || a.length !== 1) return null
  const [match, action] = [m[0], a[0]]
  if (!match || !action || action.type !== 'forward' || action.value?.length !== 1) return null
  const to = action.value[0] as string
  if (match.type === 'all') return { from: CATCH_ALL, to }
  const suffix = `@${zone.name.toLowerCase()}`
  const address = (match.value ?? '').toLowerCase()
  if (match.type !== 'literal' || match.field !== 'to' || !address.endsWith(suffix)) return null
  return { from: address.slice(0, -suffix.length), to }
}

/** Read the same way for preview and write, so they always agree. */
async function readRouting(client: CfClient, zone: Zone): Promise<{ entries: Entry[]; ids: Map<string, string>; enabled: boolean }> {
  const [status, routes] = await Promise.all([client.get<{ enabled?: boolean }>(`/zones/${zone.id}/email/routing`), readRoutes(client, zone)])
  return { entries: [...(status.enabled ? [ROUTING_ON] : []), ...routes.entries], ids: routes.ids, enabled: status.enabled === true }
}

async function readRoutes(client: CfClient, zone: Zone): Promise<{ entries: Entry[]; ids: Map<string, string> }> {
  const { result } = await client.getPage<RawRule[]>(`/zones/${zone.id}/email/routing/rules?per_page=50`)
  const all = [...result, await client.get<RawRule>(`/zones/${zone.id}/email/routing/rules/catch_all`)]
  const entries: Entry[] = []
  const ids = new Map<string, string>()
  for (const r of all) {
    const f = simpleForward(r, zone)
    if (!f) continue
    const e = route(f.from, f.to)
    if (ids.has(e.key)) continue
    entries.push(e)
    ids.set(e.key, r.id)
  }
  return { entries, ids }
}

function ruleBody(zone: Zone, from: string, to: string): Record<string, unknown> {
  const actions = [{ type: 'forward', value: [to] }]
  if (from === CATCH_ALL) return { enabled: true, matchers: [{ type: 'all' }], actions }
  return { name: `Zonekeeper: ${from}`, enabled: true, matchers: [{ type: 'literal', field: 'to', value: `${from}@${zone.name}` }], actions }
}

/** Account-level, each must be confirmed by email. */
async function ensureDestinations(client: CfClient, zone: Zone, emails: string[]): Promise<void> {
  const account = zone.account?.id
  if (!account || emails.length === 0) return
  const { result } = await client.getPage<{ email: string }[]>(`/accounts/${account}/email/routing/addresses?per_page=50`)
  const known = new Set(result.map((a) => a.email.toLowerCase()))
  for (const email of new Set(emails)) {
    if (!known.has(email)) await client.send('POST', `/accounts/${account}/email/routing/addresses`, { email })
  }
}

async function applyRoutes(client: CfClient, zone: Zone, changes: Parameters<ItemAdapter<MailSettings>['apply']>[3]): Promise<void> {
  const mine = changes.filter((c) => c.type !== 'unchanged' && ('desired' in c ? c.desired : 'entry' in c ? c.entry : c.actual).area === ROUTING)
  if (mine.length === 0) return
  const fresh = await readRouting(client, zone)
  const status = { enabled: fresh.enabled }
  assertUnchangedSince(changes, ROUTING, fresh.entries)
  const wanted = (c: (typeof mine)[number]): { from: string; to: string } | null => {
    const e = c.type === 'add' ? c.entry : c.type === 'different' ? c.desired : null
    return e ? { from: e.key.slice('route:'.length), to: (e.value as { to: string }).to } : null
  }
  const forwards = mine.filter((c) => ('desired' in c ? c.desired : 'entry' in c ? c.entry : c.actual).key !== ROUTING_ON.key)
  await ensureDestinations(client, zone, forwards.flatMap((c) => wanted(c)?.to ?? []))
  const turnOn = mine.some((c) => c.type === 'add' && c.entry.key === ROUTING_ON.key) || forwards.some((c) => c.type !== 'extra')
  if (!status.enabled && turnOn) await client.send('POST', `/zones/${zone.id}/email/routing/dns`, {})
  if (status.enabled && mine.some((c) => c.type === 'extra' && c.actual.key === ROUTING_ON.key)) await client.send('DELETE', `/zones/${zone.id}/email/routing/dns`)
  const base = `/zones/${zone.id}/email/routing/rules`
  for (const c of forwards) {
    const w = wanted(c)
    const key = c.type === 'add' ? c.entry.key : c.type === 'different' ? c.desired.key : c.type === 'extra' ? c.actual.key : ''
    const from = key.slice('route:'.length)
    const id = fresh.ids.get(key)
    if (from === CATCH_ALL) {
      await client.send('PUT', `${base}/catch_all`, w ? ruleBody(zone, from, w.to) : { enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] })
    } else if (w && c.type === 'add') {
      await client.send('POST', base, ruleBody(zone, from, w.to))
    } else if (w && id) {
      await client.send('PUT', `${base}/${encodeURIComponent(id)}`, ruleBody(zone, from, w.to))
    } else if (c.type === 'extra' && id) {
      await client.send('DELETE', `${base}/${encodeURIComponent(id)}`)
    }
  }
}

/** Root MX records, plus Email Routing forwards. */
export function createMailAdapter(): ItemAdapter<MailSettings> {
  return {
    // Part of the Email profile adapter
    item: 'email',
    // Email Routing owns its MX records, so they're never written directly
    desired: (profile) => [
      ...profile.settings.mx.filter((m) => !isRoutingMx(m.content)).map((m) => entry(m.content, m.priority)),
      ...(profile.settings.mx.some((m) => isRoutingMx(m.content)) ? [ROUTING_ON] : []),
      ...(profile.settings.routes ?? []).map((r) => route(r.from, r.to))
    ],

    async read(client, zone, profile) {
      const r = await orUnavailable(() => readMx(client, zone))
      if (r === 'unavailable') return { entries: [], unavailable: [AREA, ROUTING] }
      const mx = r.value.filter((m) => !isRoutingMx(m.content)).map((m) => entry(m.content, m.priority ?? 0))
      // Zones using Email Routing, or profiles that want it
      const wants = profile.settings.mx.some((m) => isRoutingMx(m.content)) || (profile.settings.routes ?? []).length > 0
      if (!wants && !isCloudflareMx(r.value)) return { entries: mx, unavailable: [] }
      const routing = await orUnavailable(() => readRouting(client, zone))
      if (routing === 'unavailable') return { entries: mx, unavailable: [ROUTING] }
      return { entries: [...mx, ...routing.value.entries], unavailable: [] }
    },

    async apply(client, zone, desired, changes, unavailable) {
      await applyMx(client, zone, changes, unavailable)
      if (!unavailable.includes(ROUTING)) await applyRoutes(client, zone, changes)
      void desired
    },

    addToProfile(profile, _zone, change) {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      if (change.actual.key === ROUTING_ON.key) {
        const cf = MAIL_PROVIDERS.find((p) => p.id === 'cloudflare')?.mx ?? []
        return { ...profile, settings: { ...profile.settings, mx: [...profile.settings.mx.filter((m) => !isRoutingMx(m.content)), ...cf] } }
      }
      if (change.actual.area === ROUTING) {
        const from = change.actual.key.slice('route:'.length)
        const to = (change.actual.value as { to: string }).to
        return { ...profile, settings: { ...profile.settings, routes: [...(profile.settings.routes ?? []).filter((r) => r.from !== from), { from, to }] } }
      }
      const v = change.actual.value as { content: string; priority: number }
      return { ...profile, settings: { ...profile.settings, mx: [...profile.settings.mx.filter((m) => host(m.content) !== v.content), v] } }
    }
  }
}

async function applyMx(client: CfClient, zone: Zone, changes: Parameters<ItemAdapter<MailSettings>['apply']>[3], unavailable: string[]): Promise<void> {
  {
      if (unavailable.includes(AREA)) return
      const fresh = await readMx(client, zone)
      assertUnchangedSince(changes, AREA, fresh.filter((m) => !isRoutingMx(m.content)).map((m) => entry(m.content, m.priority ?? 0)))
      const path = `/zones/${zone.id}/dns_records`
      const idOf = (key: string): string | undefined => fresh.find((m) => `mx:${host(m.content)}` === key)?.id
      const mx = changes.filter((c) => c.type !== 'unchanged' && ('desired' in c ? c.desired : 'entry' in c ? c.entry : c.actual).area === AREA)
      // Adds first, so mail never has no server
      for (const c of mx) {
        if (c.type === 'add') {
          const v = c.entry.value as { content: string; priority: number }
          await client.send('POST', path, { type: 'MX', name: zone.name, ttl: 1, ...v })
        } else if (c.type === 'different') {
          await client.send('PATCH', `${path}/${encodeURIComponent(idOf(c.actual.key) ?? '')}`, c.desired.value)
        }
      }
      for (const c of mx) {
        if (c.type === 'extra') await client.send('DELETE', `${path}/${encodeURIComponent(idOf(c.actual.key) ?? '')}`)
      }
  }
}
