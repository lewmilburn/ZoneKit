import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult, ZoneSslView } from '../shared/ipc'
import type { ItemKind, Profile } from '../shared/model'
import type { SettingField } from '../shared/settingFields'
import { CfApiError, type CfClient } from './cloudflare/client'
import { UserError } from './errors'
import { readZoneSetting, writeZoneSetting, type ZoneSettingValues } from './items/settings'
import { orUnavailable } from './items/rules'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const saveInput = z.strictObject({ zoneId: id, field: z.string(), value: z.string(), expected: z.string(), confirmed: z.literal(true) })

function describe(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof CfApiError && e.status === 403) return "Your token or this zone's plan doesn't allow changing this setting."
  if (e instanceof CfApiError && e.status === 401) return 'Cloudflare rejected your API token.'
  return errorText(e)
}

/** Profile-managed settings are read-only. */
export function createZoneSettingsHandlers(deps: { item: ItemKind; fields: readonly SettingField[]; client: CfClient; store: { list(item: ItemKind): Promise<Profile<unknown>[]> } }) {
  async function view(zoneId: string): Promise<ZoneSslView> {
    const zone = (await deps.client.listZones()).find((z) => z.id === zoneId)
    if (!zone) throw new UserError('That zone was not found for this token.')
    const profiles = (await deps.store.list(deps.item)).filter((p) => p.zoneIds.includes(zoneId)) as Profile<ZoneSettingValues>[]
    const fields = await Promise.all(
      deps.fields.map(async ({ id: field }) => {
        const r = await orUnavailable(() => readZoneSetting(deps.client, zone, field))
        const owner = profiles.find((p) => p.settings[field] !== undefined)
        return {
          field,
          value: r === 'unavailable' ? null : r.value,
          profileValue: owner?.settings[field] ?? null,
          readOnlyNote: owner ? `Managed by profile ${owner.name}` : null
        }
      })
    )
    return { fields }
  }

  return {
    async get(raw: unknown): Promise<IpcResult<ZoneSslView>> {
      const zoneId = id.safeParse(raw)
      if (!zoneId.success) return { ok: false, error: 'That request was not valid.' }
      try {
        return { ok: true, value: await view(zoneId.data) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async save(raw: unknown): Promise<IpcResult<ZoneSslView>> {
      const i = saveInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'That request was not valid.' }
      const def = deps.fields.find((f) => f.id === i.data.field)
      if (!def?.options.some(([v]) => v === i.data.value)) return { ok: false, error: 'That value is not valid for this setting.' }
      try {
        const current = (await view(i.data.zoneId)).fields.find((f) => f.field === i.data.field)
        if (current?.readOnlyNote) throw new UserError(`${current.readOnlyNote}.`)
        if (current?.value !== i.data.expected) throw new UserError('This setting changed in Cloudflare, reload and try again.')
        await writeZoneSetting(deps.client, { id: i.data.zoneId }, i.data.field, i.data.value)
        return { ok: true, value: await view(i.data.zoneId) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
