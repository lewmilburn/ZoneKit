import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { CsamView, IpcResult } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const saveInput = z.strictObject({ zoneId: id, email: z.string().email().max(254), confirmed: z.literal(true) })

type Raw = { editable?: boolean; value?: { email?: string; email_state?: string; enabled?: boolean } }

const view = (r: Raw): CsamView => ({
  enabled: r.value?.enabled === true,
  email: r.value?.email ?? null,
  emailState: r.value?.email_state ?? null,
  editable: r.editable !== false
})

function describe(e: unknown): string {
  if (e instanceof CfApiError && e.status === 403) return `Your token can't read or change the CSAM Scanning Tool for this zone. ${e.message}`
  return errorText(e)
}

export function createComplianceHandlers(deps: { client: Pick<CfClient, 'get' | 'send'> }) {
  const path = (zoneId: string): string => `/zones/${zoneId}/settings/csam_scanner_third_party`
  return {
    async get(raw: unknown): Promise<IpcResult<CsamView>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      try {
        return { ok: true, value: view(await deps.client.get<Raw>(path(zoneId.data))) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },
    async save(raw: unknown): Promise<IpcResult<CsamView>> {
      const i = saveInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'Enter a valid email address.' }
      try {
        // Email only
        const current = await deps.client.get<Raw>(path(i.data.zoneId))
        const value = { enabled: current.value?.enabled === true, email: i.data.email }
        return { ok: true, value: view(await deps.client.send<Raw>('PATCH', path(i.data.zoneId), { value })) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
