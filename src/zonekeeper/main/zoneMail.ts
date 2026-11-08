import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult, ZoneMailView } from '../shared/ipc'
import type { Profile } from '../shared/model'
import type { MailSettings } from '../shared/schemas'
import { CfApiError, type CfClient, type Zone } from './cloudflare/client'
import { UserError } from './errors'
import { hash } from './items/rules'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const saveInput = z.strictObject({
  zoneId: id,
  recordId: id,
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  content: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
  priority: z.number().int().min(0).max(65535),
  confirmed: z.literal(true)
})

const deleteInput = z.strictObject({ zoneId: id, recordId: id, fingerprint: z.string().regex(/^[a-f0-9]{32}$/), confirmed: z.literal(true) })

interface RawMx { id: string; type: string; name: string; content: string; priority?: number }

const host = (s: string): string => s.trim().replace(/\.$/, '').toLowerCase()

function describe(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof CfApiError && e.status === 403) return "Your token can't read or change DNS for this zone."
  if (e instanceof CfApiError && e.status === 401) return 'Cloudflare rejected your API token.'
  return errorText(e)
}

/** Profile-managed records are read-only. */
export function createZoneMailHandlers(deps: { client: CfClient; store: { list(item: 'email'): Promise<Profile<unknown>[]> } }) {
  async function view(zoneId: string): Promise<{ zone: Zone; raw: RawMx[]; value: ZoneMailView }> {
    const zone = (await deps.client.listZones()).find((z) => z.id === zoneId)
    if (!zone) throw new UserError('That zone was not found for this token.')
    const qs = new URLSearchParams({ type: 'MX', per_page: '100' })
    const { result } = await deps.client.getPage<RawMx[]>(`/zones/${zone.id}/dns_records?${qs}`)
    const raw = result.filter((r) => r.type === 'MX' && r.name.toLowerCase() === zone.name.toLowerCase())
    const profiles = (await deps.store.list('email')).filter((p) => p.zoneIds.includes(zoneId)) as Profile<Partial<MailSettings>>[]
    const ownerOf = (content: string): Profile<Partial<MailSettings>> | undefined => profiles.find((p) => (p.settings.mx ?? []).some((m) => host(m.content) === host(content)))
    return {
      zone,
      raw,
      value: {
        profileName: profiles.map((p) => p.name).join(', ') || null,
        records: raw.map((r) => ({
          id: r.id,
          content: r.content,
          priority: r.priority ?? 0,
          fingerprint: hash({ id: r.id, content: r.content, priority: r.priority ?? 0 }),
          readOnlyNote: ownerOf(r.content) ? `Managed by profile ${ownerOf(r.content)?.name}` : null
        }))
      }
    }
  }

  return {
    async get(raw: unknown): Promise<IpcResult<ZoneMailView>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      try {
        return { ok: true, value: (await view(zoneId.data)).value }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async save(raw: unknown): Promise<IpcResult<ZoneMailView>> {
      const i = saveInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'Enter a valid mail server and a priority from 0 to 65535.' }
      try {
        const current = (await view(i.data.zoneId)).value.records.find((r) => r.id === i.data.recordId)
        if (!current || current.fingerprint !== i.data.fingerprint) throw new UserError('This record changed in Cloudflare, reload and try again.')
        if (current.readOnlyNote) throw new UserError(`${current.readOnlyNote}.`)
        await deps.client.send('PATCH', `/zones/${i.data.zoneId}/dns_records/${encodeURIComponent(i.data.recordId)}`, { content: i.data.content, priority: i.data.priority })
        return { ok: true, value: (await view(i.data.zoneId)).value }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async remove(raw: unknown): Promise<IpcResult<ZoneMailView>> {
      const i = deleteInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'That request was not valid.' }
      try {
        const current = (await view(i.data.zoneId)).value.records.find((r) => r.id === i.data.recordId)
        if (!current || current.fingerprint !== i.data.fingerprint) throw new UserError('This record changed in Cloudflare, reload and try again.')
        if (current.readOnlyNote) throw new UserError(`${current.readOnlyNote}.`)
        await deps.client.send('DELETE', `/zones/${i.data.zoneId}/dns_records/${encodeURIComponent(i.data.recordId)}`)
        return { ok: true, value: (await view(i.data.zoneId)).value }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
