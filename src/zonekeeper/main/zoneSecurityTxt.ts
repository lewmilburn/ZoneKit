import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult, ZoneSecurityTxtView } from '../shared/ipc'
import type { Profile } from '../shared/model'
import { securityTxtSchema, describeIssues } from '../shared/schemas'
import { CfApiError, type CfClient } from './cloudflare/client'
import { UserError } from './errors'
import { normalizeSecurityTxt, readSecurityTxt, writeSecurityTxt } from './items/secset'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const saveInput = z.strictObject({ zoneId: id, value: z.unknown(), confirmed: z.literal(true) })

function describe(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof CfApiError && e.status === 403) return "Your token needs Zone Settings access for security.txt."
  return errorText(e)
}

export function createZoneSecurityTxtHandlers(deps: { client: Pick<CfClient, 'get' | 'send'>; store: { list(item: 'secset'): Promise<Profile<unknown>[]> } }) {
  const ownerOf = async (zoneId: string): Promise<string | null> =>
    (await deps.store.list('secset')).find((p) => p.zoneIds.includes(zoneId) && (p.settings as { security_txt?: unknown }).security_txt !== undefined)?.name ?? null

  async function view(zoneId: string): Promise<ZoneSecurityTxtView> {
    return { value: await readSecurityTxt(deps.client, zoneId), profileName: await ownerOf(zoneId) }
  }

  return {
    async get(raw: unknown): Promise<IpcResult<ZoneSecurityTxtView>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      try {
        return { ok: true, value: await view(zoneId.data) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async save(raw: unknown): Promise<IpcResult<ZoneSecurityTxtView>> {
      const i = saveInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'That request was not valid.' }
      const parsed = securityTxtSchema.safeParse(i.data.value)
      if (!parsed.success) return { ok: false, error: describeIssues(parsed.error) }
      try {
        const owner = await ownerOf(i.data.zoneId)
        if (owner) throw new UserError(`This zone's security.txt is managed by profile ${owner}.`)
        await writeSecurityTxt(deps.client, i.data.zoneId, normalizeSecurityTxt(parsed.data))
        return { ok: true, value: await view(i.data.zoneId) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
