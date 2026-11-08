import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { AlertType, IpcResult, NotificationPolicy, NotificationsView } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'

const accountId = z.string().regex(/^[a-f0-9]{32}$/i)
const email = z.string().email().max(254)
const saveInput = z.strictObject({
  accountId,
  /** Omit to create. */
  policyId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  name: z.string().trim().min(1).max(200),
  alertType: z.string().regex(/^[a-z0-9_]{1,100}$/),
  enabled: z.boolean(),
  emails: z.array(email).min(1).max(50),
  zoneIds: z.array(z.string().regex(/^[a-f0-9]{32}$/i)).max(1000),
  confirmed: z.literal(true)
})
const deleteInput = z.strictObject({ accountId, policyId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), confirmed: z.literal(true) })

type RawAlert = { type?: string; display_name?: string; description?: string; filter_options?: Array<{ Key?: string }> }
type RawPolicy = { id?: string; name?: string; alert_type?: string; enabled?: boolean; mechanisms?: { email?: Array<{ id?: string }> }; filters?: { zones?: string[] } }

function describe(e: unknown): string {
  if (e instanceof CfApiError && e.status === 403) return `Your token needs the Notifications Write permission. ${e.message}`
  return errorText(e)
}

export function createNotificationHandlers(deps: { client: Pick<CfClient, 'get' | 'send' | 'listZones'> }) {
  const base = (id: string): string => `/accounts/${id}/alerting/v3`

  async function view(id: string): Promise<NotificationsView> {
    const [available, policies] = await Promise.all([
      deps.client.get<Record<string, RawAlert[]>>(`${base(id)}/available_alerts`),
      deps.client.get<RawPolicy[]>(`${base(id)}/policies`)
    ])
    const types: AlertType[] = Object.entries(available ?? {}).flatMap(([group, list]) =>
      (list ?? []).flatMap((a) =>
        a.type ? [{ type: a.type, name: a.display_name ?? a.type, description: a.description ?? '', group, zoneFilter: (a.filter_options ?? []).some((f) => f.Key === 'zones') }] : []
      )
    )
    const list: NotificationPolicy[] = (policies ?? []).map((p) => ({
      id: p.id ?? '',
      name: p.name ?? '',
      alertType: p.alert_type ?? '',
      enabled: p.enabled !== false,
      emails: (p.mechanisms?.email ?? []).flatMap((m) => (m.id ? [m.id] : [])),
      zoneIds: p.filters?.zones ?? []
    }))
    return { accountId: id, types, policies: list }
  }

  return {
    /** One per account the zones belong to. */
    async list(): Promise<IpcResult<NotificationsView[]>> {
      try {
        const zones = await deps.client.listZones()
        const ids = [...new Set(zones.flatMap((z) => (z.account?.id ? [z.account.id] : [])))]
        return { ok: true, value: await Promise.all(ids.map(view)) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async save(raw: unknown): Promise<IpcResult<NotificationsView>> {
      const i = saveInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'Check the name, alert type and email addresses.' }
      const d = i.data
      const body = {
        name: d.name,
        alert_type: d.alertType,
        enabled: d.enabled,
        mechanisms: { email: d.emails.map((e) => ({ id: e })) },
        filters: d.zoneIds.length > 0 ? { zones: d.zoneIds } : {}
      }
      try {
        if (d.policyId) await deps.client.send('PUT', `${base(d.accountId)}/policies/${encodeURIComponent(d.policyId)}`, body)
        else await deps.client.send('POST', `${base(d.accountId)}/policies`, body)
        return { ok: true, value: await view(d.accountId) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async remove(raw: unknown): Promise<IpcResult<NotificationsView>> {
      const i = deleteInput.safeParse(raw)
      if (!i.success) return { ok: false, error: 'That request was not valid.' }
      try {
        await deps.client.send('DELETE', `${base(i.data.accountId)}/policies/${encodeURIComponent(i.data.policyId)}`)
        return { ok: true, value: await view(i.data.accountId) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
