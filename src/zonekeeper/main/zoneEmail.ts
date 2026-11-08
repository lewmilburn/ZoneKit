import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult, ZoneEmailAreaView, ZoneEmailRecordView, ZoneEmailView } from '../shared/ipc'
import type { Entry, Profile } from '../shared/model'
import { isDmarcValue, isSpfValue, type EmailSettings } from '../shared/schemas'
import { CfApiError, type CfClient, type Zone } from './cloudflare/client'
import { UserError } from './errors'
import { desiredEntries, formatTxt, parseTxt, scan, type Area, type Found } from './items/email'
import { hash } from './items/rules'

export interface ZoneEmailDeps {
  client: Pick<CfClient, 'get' | 'getPage' | 'send' | 'listZones'>
  store: { list(item: 'email'): Promise<Profile<unknown>[]> }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const idSchema = z.string().regex(ID)
const saveSchema = z.strictObject({
  zoneId: idSchema,
  recordId: idSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  content: z.string().min(1).max(4000),
  confirmed: z.literal(true)
})

const BAD = 'That request was not valid.'
const RELOAD = 'This record changed in Cloudflare, reload and try again.'
const AREAS: Area[] = ['spf', 'dmarc', 'dkim', 'tlsrpt', 'bimi']
const HOST = /^[A-Za-z0-9_]([A-Za-z0-9_.-]{0,251}[A-Za-z0-9_.])?$/

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

interface Context {
  zone: Zone
  profileName: string | null
  managed: Set<string>
  desired: Map<string, Entry>
}

async function loadContext(deps: ZoneEmailDeps, zoneId: string): Promise<Context> {
  const zone = (await deps.client.listZones()).find((z) => z.id === zoneId)
  if (!zone) throw new UserError('That zone was not found for this token.')
  const profiles = (await deps.store.list('email')).filter((p) => p.zoneIds.includes(zoneId))
  if (profiles.length === 0) return { zone, profileName: null, managed: new Set(), desired: new Map() }
  const entries: Entry[] = []
  for (const profile of profiles) {
    try {
      entries.push(...desiredEntries((profile as Profile<EmailSettings>).settings, zone))
    } catch (e) {
      throw new UserError(`The Email profile "${profile.name}" could not be resolved for this zone, so records can't be shown: ${describe(e)}`)
    }
  }
  return { zone, profileName: profiles.map((p) => p.name).join(', '), managed: new Set(entries.map((e) => e.key)), desired: new Map(entries.map((e) => [e.key, e])) }
}

async function scanAll(deps: ZoneEmailDeps, ctx: Context): Promise<{ found: Found[]; unavailable: Area[]; warnings: string[] }> {
  // Same key assignment as a sync
  return scan(deps.client as unknown as CfClient, ctx.zone, AREAS, ctx.desired)
}

const noteFor = (ctx: Context, f: Found): string | null => (ctx.profileName !== null && !f.key.includes('#') && ctx.managed.has(f.key) ? `Managed by profile ${ctx.profileName}` : null)

function fingerprint(r: Found['raw']): string {
  return hash({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl ?? null, proxied: r.proxied ?? null })
}

function toRecord(ctx: Context, f: Found): ZoneEmailRecordView {
  return {
    id: f.raw.id,
    type: f.raw.type,
    name: f.raw.name,
    content: f.raw.type === 'TXT' ? parseTxt(f.raw.content) : f.raw.content,
    fingerprint: fingerprint(f.raw),
    readOnlyNote: noteFor(ctx, f)
  }
}

async function buildView(deps: ZoneEmailDeps, zoneId: string): Promise<ZoneEmailView> {
  const ctx = await loadContext(deps, zoneId)
  const s = await scanAll(deps, ctx)
  const areas: ZoneEmailAreaView[] = AREAS.map((area) =>
    s.unavailable.includes(area)
      ? { area, status: 'unavailable', records: [] }
      : { area, status: 'ok', records: s.found.filter((f) => f.area === area).map((f) => toRecord(ctx, f)) }
  )
  return { zoneId, zoneName: ctx.zone.name, profileName: ctx.profileName, areas, warnings: ctx.profileName === null ? s.warnings.filter((w) => !w.includes('is not in the profile')) : s.warnings }
}

function validate(area: Area, type: string, value: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'The value must not contain control characters.'
  if (type === 'CNAME') return HOST.test(value.trim()) ? null : 'The CNAME target must be a valid host name.'
  if (area === 'spf' && !isSpfValue(value)) return 'An SPF record must start with v=spf1.'
  if (area === 'dmarc' && !isDmarcValue(value)) return 'A DMARC record must start with v=DMARC1.'
  return value.trim() === '' ? 'The value can not be empty.' : null
}

export function createZoneEmailHandlers(deps: ZoneEmailDeps) {
  return {
    async get(raw: unknown): Promise<IpcResult<ZoneEmailView>> {
      const id = idSchema.safeParse(raw)
      if (!id.success) return { ok: false, error: BAD }
      try {
        return { ok: true, value: await buildView(deps, id.data) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async save(raw: unknown): Promise<IpcResult<ZoneEmailView>> {
      const input = saveSchema.safeParse(raw)
      if (!input.success) return { ok: false, error: BAD }
      const i = input.data
      try {
        const ctx = await loadContext(deps, i.zoneId)
        const s = await scanAll(deps, ctx)
        const f = s.found.find((x) => x.raw.id === i.recordId)
        if (!f) {
          if (s.unavailable.length > 0) throw new UserError("Your token can't read this.")
          throw new UserError(RELOAD)
        }
        const note = noteFor(ctx, f)
        if (note) throw new UserError(`${note}.`)
        if (fingerprint(f.raw) !== i.fingerprint) throw new UserError(RELOAD)
        const bad = validate(f.area, f.raw.type, i.content)
        if (bad) throw new UserError(bad)
        const content = f.raw.type === 'TXT' ? formatTxt(i.content) : i.content.trim()
        // Content only
        await deps.client.send('PATCH', `/zones/${i.zoneId}/dns_records/${encodeURIComponent(f.raw.id)}`, { content })
        return { ok: true, value: await buildView(deps, i.zoneId) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
