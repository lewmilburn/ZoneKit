import { describe, expect, it } from 'vitest'
import { CfClient } from '../../src/zonekeeper/main/cloudflare/client'
import { createZoneEmailHandlers } from '../../src/zonekeeper/main/zoneEmail'

const ZONE = { id: 'z1', name: 'example.com', account: { id: 'a1' } }
const RECORDS = [
  { id: 'spf1', type: 'TXT', name: 'example.com', content: '"v=spf1 -all"', ttl: 1, proxied: false },
  { id: 'dmarc1', type: 'TXT', name: '_dmarc.example.com', content: '"v=DMARC1; p=none"', ttl: 1, proxied: false }
]

function setup(opts: { inProfile?: boolean; forbid?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  let records = RECORDS
  const fetchFn = (async (url: string, init: { method: string; body?: string }) => {
    const path = url.replace('https://api.cloudflare.com/client/v4', '')
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined })
    const ok = (result: unknown, extra = {}) => new Response(JSON.stringify({ success: true, result, ...extra }), { status: 200 })
    if (path.startsWith('/zones?')) return ok([ZONE], { result_info: { page: 1, total_pages: 1 } })
    if (init.method === 'GET' && path.includes('/dns_records')) {
      if (opts.forbid) return new Response(JSON.stringify({ success: false, errors: [{ message: 'no' }] }), { status: 403 })
      return ok(records, { result_info: { page: 1, total_pages: 1 } })
    }
    return ok({})
  }) as unknown as typeof fetch
  const client = new CfClient({ fetch: fetchFn, getToken: async () => 'tok' })
  const profile = { id: 'p1', item: 'email' as const, name: 'Base', version: 1, zoneIds: ['z1'], updatedAt: 'x', settings: { spf: 'v=spf1 -all', dmarc: null, dkim: [] } }
  const handlers = createZoneEmailHandlers({ client, store: { list: async () => (opts.inProfile ? [profile] : []) } })
  return { calls, handlers, setRecords: (r: typeof RECORDS) => (records = r) }
}

const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== 'GET')

async function record(handlers: ReturnType<typeof setup>['handlers'], area: string) {
  const r = await handlers.get('z1')
  if (!r.ok) throw new Error(r.error)
  return r.value.areas.find((a) => a.area === area)!.records[0]!
}

describe('zone email', () => {
  it('refuses to edit a record managed by a profile', async () => {
    const { handlers, calls } = setup({ inProfile: true })
    const spf = await record(handlers, 'spf')
    expect(spf.readOnlyNote).toBe('Managed by profile Base')
    const r = await handlers.save({ zoneId: 'z1', recordId: spf.id, fingerprint: spf.fingerprint, content: 'v=spf1 ~all', confirmed: true })
    expect(r.ok).toBe(false)
    expect(writes(calls)).toEqual([])
  })

  it('refuses to save a record that changed since it was opened', async () => {
    const { handlers, calls, setRecords } = setup()
    const spf = await record(handlers, 'spf')
    setRecords([{ ...RECORDS[0]!, content: '"v=spf1 include:other -all"' }, RECORDS[1]!])
    const r = await handlers.save({ zoneId: 'z1', recordId: spf.id, fingerprint: spf.fingerprint, content: 'v=spf1 ~all', confirmed: true })
    expect(r.ok).toBe(false)
    expect(writes(calls)).toEqual([])
  })

  it('sends only one PATCH, with only the content', async () => {
    const { handlers, calls } = setup()
    const spf = await record(handlers, 'spf')
    const r = await handlers.save({ zoneId: 'z1', recordId: spf.id, fingerprint: spf.fingerprint, content: 'v=spf1 ~all', confirmed: true })
    expect(r.ok).toBe(true)
    const w = writes(calls)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ method: 'PATCH', path: '/zones/z1/dns_records/spf1' })
    expect(Object.keys((w[0] as unknown as { body: object }).body)).toEqual(['content'])
  })

  it('refuses an SPF value that does not start with v=spf1', async () => {
    const { handlers, calls } = setup()
    const spf = await record(handlers, 'spf')
    const r = await handlers.save({ zoneId: 'z1', recordId: spf.id, fingerprint: spf.fingerprint, content: 'hello', confirmed: true })
    expect(r.ok).toBe(false)
    expect(writes(calls)).toEqual([])
  })

  it('reports a 403 as unavailable, never as empty', async () => {
    const { handlers } = setup({ forbid: true })
    const r = await handlers.get('z1')
    expect(r.ok && r.value.areas.every((a) => a.status === 'unavailable')).toBe(true)
  })
})
