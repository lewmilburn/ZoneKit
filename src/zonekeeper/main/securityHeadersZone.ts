import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult } from '../shared/ipc'
import type { Profile } from '../shared/model'
import { WIZARD_RULE_REF, headersFromRule, wizardRule } from '../shared/securityHeaders'
import { CfApiError, type CfClient } from './cloudflare/client'
import { UserError } from './errors'
import { HEADERS } from './items/security'
import { readEntrypoint, writeEntrypoint } from './items/rules'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const saveInput = z.strictObject({ zoneId: id, headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().min(1).max(4000)), confirmed: z.literal(true) })

function describe(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof CfApiError && e.status === 403) return 'Your token needs the Transform Rules permission for this zone.'
  if (e instanceof CfApiError && e.status === 401) return 'Cloudflare rejected your API token.'
  return errorText(e)
}

/** Other rules in the phase are kept. */
export function createZoneHeaderHandlers(deps: { client: CfClient; store: { list(item: 'sechead'): Promise<Profile<unknown>[]> } }) {
  const scope = (zoneId: string): string => `zones/${zoneId}`
  return {
    async get(raw: unknown): Promise<IpcResult<Record<string, string>>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      try {
        const rules = await readEntrypoint(deps.client, scope(zoneId.data), HEADERS)
        return { ok: true, value: headersFromRule(rules?.find((r) => r.ref === WIZARD_RULE_REF)) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async save(raw: unknown): Promise<IpcResult<Record<string, string>>> {
      const i = saveInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'Check the header values.' }
      const { zoneId, headers } = i.data
      try {
        const owner = (await deps.store.list('sechead')).find((p) => p.zoneIds.includes(zoneId))
        if (owner) throw new UserError(`This zone is in the Security Headers profile "${owner.name}". Set its headers on that profile.`)
        const fresh = await readEntrypoint(deps.client, scope(zoneId), HEADERS)
        const kept = (fresh ?? []).filter((r) => r.ref !== WIZARD_RULE_REF).map((r) => {
          const { version: _v, last_updated: _l, ...rest } = r
          return rest
        })
        const rules = Object.keys(headers).length > 0 ? [...kept, wizardRule(headers)] : kept
        await writeEntrypoint(deps.client, scope(zoneId), 'zone', HEADERS, fresh !== null, rules)
        return { ok: true, value: headers }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
