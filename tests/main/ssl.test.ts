import { describe, expect, it } from 'vitest'
import type { CfClient, Zone } from '../../src/zonekeeper/main/cloudflare/client'
import { createSettingsAdapter } from '../../src/zonekeeper/main/items/settings'
import { createZoneSettingsHandlers } from '../../src/zonekeeper/main/zoneSettings'
import type { Profile } from '../../src/zonekeeper/shared/model'
import { SSL_FIELDS } from '../../src/zonekeeper/shared/settingFields'

type Values = Record<string, string | undefined>
const zone = { id: 'z1', name: 'a.com' } as Zone

function fake(values: Record<string, string> = { ssl: 'full', always_use_https: 'off' }) {
  const sends: Array<{ path: string; body: unknown }> = []
  const client = {
    listZones: async () => [zone],
    get: async (path: string) => ({ value: values[path.split('/').pop() as string] ?? 'on' }),
    send: async (_m: string, path: string, body: unknown) => {
      sends.push({ path, body })
      return {}
    }
  } as unknown as CfClient
  return { client, sends }
}
const profile = (settings: Values) => ({ id: 'p', item: 'ssl', name: 'Base', zoneIds: ['z1'], settings, version: 1, updatedAt: 'x' }) as Profile<Values>
const adapter = () => createSettingsAdapter('ssl', SSL_FIELDS)

describe('ssl settings', () => {
  it('compares only the settings a profile sets', async () => {
    const r = await adapter().read(fake().client, zone, profile({ ssl: 'strict' }))
    expect(r.entries.map((e) => e.key)).toEqual(['setting:ssl'])
  })

  it('patches only changed settings', async () => {
    const { client, sends } = fake()
    const desired = { key: 'setting:ssl', area: 'ssl', value: 'strict' }
    await adapter().apply(client, zone, [desired], [{ type: 'different', desired, actual: { ...desired, value: 'full' } }], [])
    expect(sends).toEqual([{ path: '/zones/z1/settings/ssl', body: { value: 'strict' } }])
  })

  it('reads TLS 1.3 with 0-RTT as plain on, as 0-RTT belongs to Speed', async () => {
    const r = await adapter().read(fake({ tls_1_3: 'zrt' }).client, zone, profile({ tls_1_3: 'on' }))
    expect(r.entries).toEqual([{ key: 'setting:tls_1_3', area: 'tls_1_3', value: 'on' }])
  })

  it('refuses a direct edit of a profile setting, an invalid value and a stale value', async () => {
    const { client, sends } = fake()
    const handlers = (list: Profile<unknown>[]) => createZoneSettingsHandlers({ item: 'ssl', fields: SSL_FIELDS, client, store: { list: async () => list } })
    const managed = handlers([profile({ ssl: 'strict' })])
    const free = handlers([])
    const base = { zoneId: 'z1', field: 'ssl', confirmed: true }
    expect((await managed.save({ ...base, value: 'off', expected: 'full' })).ok).toBe(false)
    expect((await free.save({ ...base, value: 'nope', expected: 'full' })).ok).toBe(false)
    expect((await free.save({ ...base, value: 'off', expected: 'flexible' })).ok).toBe(false)
    expect(sends).toEqual([])
    expect((await free.save({ ...base, value: 'off', expected: 'full' })).ok).toBe(true)
  })
})
