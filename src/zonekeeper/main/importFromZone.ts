import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult } from '../shared/ipc'
import type { ItemKind, Profile } from '../shared/model'
import type { CfClient } from './cloudflare/client'
import type { ItemAdapter } from './sync/adapter'

const input = z.strictObject({ profileId: z.string().min(1).max(200), zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })

/** Saves nothing: the editor does. */
export function createImportFromZone(deps: {
  client: CfClient
  store: { get(id: string): Promise<Profile<unknown> | undefined> }
  adapters: Partial<Record<ItemKind, ItemAdapter<unknown>>>
}) {
  return async (raw: unknown): Promise<IpcResult<{ settings: unknown; unavailable: string[] }>> => {
    const i = input.safeParse(raw)
    if (!i.success) return { ok: false, error: 'That request was not valid.' }
    try {
      const profile = await deps.store.get(i.data.profileId)
      const adapter = profile && deps.adapters[profile.item]
      const zone = (await deps.client.listZones()).find((z) => z.id === i.data.zoneId)
      if (!profile || !adapter || !zone) return { ok: false, error: 'That profile or zone was not found.' }
      const read = await (adapter.readForImport ?? adapter.read)(deps.client, zone, profile)
      let next = profile
      for (const actual of read.entries) next = adapter.addToProfile(next, zone, { type: 'extra', actual }) as typeof next
      return { ok: true, value: { settings: next.settings, unavailable: read.unavailable } }
    } catch (e) {
      return { ok: false, error: `This zone's settings couldn't be read: ${errorText(e)}` }
    }
  }
}
