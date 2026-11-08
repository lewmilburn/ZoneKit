import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { DmarcReportsView, DnssecView, IpcResult } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const dnssecInput = z.strictObject({
  zoneId: id,
  enable: z.boolean().optional(),
  multiSigner: z.boolean().optional(),
  presigned: z.boolean().optional(),
  nsec3: z.boolean().optional(),
  confirmed: z.literal(true)
})
const reportsInput = z.strictObject({ zoneId: id, enable: z.boolean(), confirmed: z.literal(true) })

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null)

function describe(e: unknown, what: string): string {
  if (e instanceof CfApiError && e.status === 403) return `Your token doesn't have access to ${what} for this zone.`
  if (/invalid zone plan/i.test(errorText(e))) return "This zone's plan doesn't include that setting."
  return errorText(e)
}

function toDnssec(r: Record<string, unknown>): DnssecView {
  return {
    status: s(r.status) ?? 'disabled',
    ds: s(r.ds),
    keyTag: s(r.key_tag),
    algorithm: s(r.algorithm),
    digestType: s(r.digest_type),
    digest: s(r.digest),
    multiSigner: r.dnssec_multi_signer === true,
    presigned: r.dnssec_presigned === true,
    nsec3: r.dnssec_use_nsec3 === true
  }
}

function toReports(r: Record<string, unknown>): DmarcReportsView {
  return { enabled: r.enabled === true, status: s(r.status) }
}

export function createZoneDnssecHandlers(deps: { client: Pick<CfClient, 'get' | 'send'> }) {
  return {
    async dnssecGet(raw: unknown): Promise<IpcResult<DnssecView>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      try {
        return { ok: true, value: toDnssec(await deps.client.get<Record<string, unknown>>(`/zones/${zoneId.data}/dnssec`)) }
      } catch (e) {
        return { ok: false, error: describe(e, 'DNSSEC') }
      }
    },

    async dnssecSave(raw: unknown): Promise<IpcResult<DnssecView>> {
      const i = dnssecInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'That request was not valid.' }
      try {
        const { enable, multiSigner, presigned, nsec3 } = i.data
        const body = {
          ...(enable === undefined ? {} : { status: enable ? 'active' : 'disabled' }),
          ...(multiSigner === undefined ? {} : { dnssec_multi_signer: multiSigner }),
          ...(presigned === undefined ? {} : { dnssec_presigned: presigned }),
          ...(nsec3 === undefined ? {} : { dnssec_use_nsec3: nsec3 })
        }
        const r = await deps.client.send<Record<string, unknown>>('PATCH', `/zones/${i.data.zoneId}/dnssec`, body)
        return { ok: true, value: toDnssec(r) }
      } catch (e) {
        return { ok: false, error: describe(e, 'DNSSEC') }
      }
    },

    async reportsGet(raw: unknown): Promise<IpcResult<DmarcReportsView>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      try {
        return { ok: true, value: toReports(await deps.client.get<Record<string, unknown>>(`/zones/${zoneId.data}/email/auth/dmarc-reports`)) }
      } catch (e) {
        return { ok: false, error: describe(e, 'DMARC reports') }
      }
    },

    async reportsSave(raw: unknown): Promise<IpcResult<DmarcReportsView>> {
      const i = reportsInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'That request was not valid.' }
      try {
        const r = await deps.client.send<Record<string, unknown>>('PATCH', `/zones/${i.data.zoneId}/email/auth/dmarc-reports`, { enabled: i.data.enable })
        return { ok: true, value: toReports(r) }
      } catch (e) {
        return { ok: false, error: describe(e, 'DMARC reports') }
      }
    }
  }
}
