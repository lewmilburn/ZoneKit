import { z } from 'zod'
import { errorText } from '../shared/errorText'
import { DNS_TYPES, type DnsRecordView, type IpcResult } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'
import { UserError } from './errors'
import { hash } from './items/rules'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const fields = z.strictObject({
  type: z.enum(DNS_TYPES),
  name: z.string().min(1).max(255),
  content: z.string().min(1).max(4096),
  ttl: z.number().int().min(1).max(86400),
  proxied: z.boolean(),
  priority: z.number().int().min(0).max(65535).optional()
})
const createInput = z.strictObject({ zoneId: id, record: fields, confirmed: z.literal(true) })
const updateInput = z.strictObject({ zoneId: id, recordId: id, fingerprint: z.string(), record: fields, confirmed: z.literal(true) })
const removeInput = z.strictObject({ zoneId: id, recordId: id, fingerprint: z.string(), confirmed: z.literal(true) })

interface Raw { id: string; type: string; name: string; content: string; ttl?: number; proxied?: boolean; proxiable?: boolean; priority?: number }
type Field = z.infer<typeof fields>

function describe(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof CfApiError) {
    if (e.status === 401) return 'Cloudflare rejected your API token.'
    if (e.status === 403) return "Your token can't read or change DNS for this zone."
    if (e.status === 0) return "Couldn't reach Cloudflare, check your connection."
    return `Cloudflare refused this: ${e.message}`
  }
  return errorText(e)
}

const body = (r: Field): Record<string, unknown> => ({
  type: r.type,
  name: r.name,
  content: r.content,
  ttl: r.ttl,
  ...(['A', 'AAAA', 'CNAME'].includes(r.type) ? { proxied: r.proxied } : {}),
  ...(r.type === 'MX' ? { priority: r.priority ?? 10 } : {})
})

export function createZoneDnsHandlers(deps: { client: Pick<CfClient, 'getPage' | 'send'> }) {
  const path = (zoneId: string): string => `/zones/${zoneId}/dns_records`

  async function list(zoneId: string): Promise<DnsRecordView[]> {
    const out: Raw[] = []
    for (let page = 1; page <= 100; page++) {
      const { result } = await deps.client.getPage<Raw[]>(`${path(zoneId)}?${new URLSearchParams({ per_page: '100', page: String(page) })}`)
      out.push(...result)
      if (result.length < 100) break
    }
    return out
      .map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        content: r.content,
        ttl: r.ttl ?? 1,
        proxied: r.proxied === true,
        proxiable: r.proxiable === true,
        ...(r.priority === undefined ? {} : { priority: r.priority }),
        fingerprint: hash({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl ?? 1, proxied: r.proxied ?? false, priority: r.priority ?? null })
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
  }

  async function checkUnchanged(zoneId: string, recordId: string, fingerprint: string): Promise<void> {
    const current = (await list(zoneId)).find((r) => r.id === recordId)
    if (!current || current.fingerprint !== fingerprint) throw new UserError('This record changed in Cloudflare, reload and try again.')
  }

  const run = async (zoneId: string, work: () => Promise<unknown>): Promise<IpcResult<DnsRecordView[]>> => {
    try {
      await work()
      return { ok: true, value: await list(zoneId) }
    } catch (e) {
      return { ok: false, error: describe(e) }
    }
  }

  return {
    async get(raw: unknown): Promise<IpcResult<DnsRecordView[]>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      return run(zoneId.data, async () => undefined)
    },
    async create(raw: unknown): Promise<IpcResult<DnsRecordView[]>> {
      const i = createInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'Check the record fields.' }
      return run(i.data.zoneId, () => deps.client.send('POST', path(i.data.zoneId), body(i.data.record)))
    },
    async update(raw: unknown): Promise<IpcResult<DnsRecordView[]>> {
      const i = updateInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'Check the record fields.' }
      return run(i.data.zoneId, async () => {
        await checkUnchanged(i.data.zoneId, i.data.recordId, i.data.fingerprint)
        await deps.client.send('PATCH', `${path(i.data.zoneId)}/${encodeURIComponent(i.data.recordId)}`, body(i.data.record))
      })
    },
    async remove(raw: unknown): Promise<IpcResult<DnsRecordView[]>> {
      const i = removeInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'That request was not valid.' }
      return run(i.data.zoneId, async () => {
        await checkUnchanged(i.data.zoneId, i.data.recordId, i.data.fingerprint)
        await deps.client.send('DELETE', `${path(i.data.zoneId)}/${encodeURIComponent(i.data.recordId)}`)
      })
    }
  }
}
