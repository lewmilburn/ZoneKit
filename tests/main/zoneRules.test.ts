import { describe, expect, it } from 'vitest'
import { CfClient } from '../../src/zonekeeper/main/cloudflare/client'
import { createRulesAdapter } from '../../src/zonekeeper/main/items/rules'
import { createZoneRulesHandlers } from '../../src/zonekeeper/main/zoneRules'

const PHASE = 'http_request_firewall_custom'
const ZONE = { id: 'z1', name: 'example.com', account: { id: 'a1' } }

function setup(opts: { live?: () => unknown[]; forbid?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const live =
    opts.live ??
    (() => [
      { id: 'r1', ref: 'managed-1', expression: 'true', action: 'block', enabled: true, version: '1' },
      { id: 'r2', expression: 'ip.src eq 1.1.1.1', action: 'block', enabled: true, description: 'free', version: '1' }
    ])
  const fetchFn = (async (url: string, init: { method: string; body?: string }) => {
    const path = url.replace('https://api.cloudflare.com/client/v4', '')
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined })
    const ok = (result: unknown, extra = {}) => new Response(JSON.stringify({ success: true, result, ...extra }), { status: 200 })
    if (path.startsWith('/zones?')) return ok([ZONE], { result_info: { page: 1, total_pages: 1 } })
    if (path.includes('/entrypoint')) {
      if (opts.forbid || !path.includes(PHASE)) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'no' }] }), { status: opts.forbid ? 403 : 404 })
      }
      return ok({ id: 'rs1', rules: live() })
    }
    return ok({})
  }) as unknown as typeof fetch
  const client = new CfClient({ fetch: fetchFn, getToken: async () => 'tok' })
  const profile = {
    id: 'p1',
    item: 'rules' as const,
    name: 'Base',
    version: 1,
    zoneIds: ['z1'],
    updatedAt: 'x',
    settings: {
      phases: {
        [PHASE]: [{ ref: 'managed-1', expression: 'true', action: 'block', enabled: true }],
        http_request_dynamic_redirect: [],
        http_request_late_transform: [],
        http_response_headers_transform: []
      },
      pageRules: [],
      bulkRedirects: []
    }
  }
  const handlers = createZoneRulesHandlers({
    client,
    store: { list: async () => [profile] },
    adapter: createRulesAdapter({ snapshots: {} as never })
  })
  return { handlers, calls }
}

const edit = (ruleId: string, fingerprint: string) => ({
  zoneId: 'z1',
  phase: PHASE,
  ruleId,
  fingerprint,
  description: 'new',
  expression: 'false',
  enabled: false,
  confirmed: true as const
})

describe('zone rules editing', () => {
  it('marks profile rules read-only and refuses to save them', async () => {
    const { handlers, calls } = setup()
    const view = await handlers.get('z1')
    if (!view.ok) throw new Error('get failed')
    const rules = view.value.phases[0].rules
    expect(rules[0].readOnlyNote).toBe('Managed by profile Base')
    expect(rules[1].readOnlyNote).toBeNull()
    const r = await handlers.save(edit('r1', rules[0].fingerprint))
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('refuses to save a rule that changed since it was opened', async () => {
    let expression = 'ip.src eq 1.1.1.1'
    const { handlers, calls } = setup({ live: () => [{ id: 'r2', expression, action: 'block', enabled: true, version: '1' }] })
    const view = await handlers.get('z1')
    if (!view.ok) throw new Error('get failed')
    const fp = view.value.phases[0].rules[0].fingerprint
    expression = 'ip.src eq 2.2.2.2'
    const r = await handlers.save(edit('r2', fp))
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('writes only through the single-rule endpoint, keeping ref', async () => {
    const { handlers, calls } = setup()
    const view = await handlers.get('z1')
    if (!view.ok) throw new Error('get failed')
    const r = await handlers.save(edit('r2', view.value.phases[0].rules[1].fingerprint))
    expect(r.ok).toBe(true)
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe('PATCH')
    expect(writes[0].path).toBe(`/zones/z1/rulesets/rs1/rules/r2`)
    expect(writes[0].body).toMatchObject({ description: 'new', expression: 'false', enabled: false, action: 'block' })
    expect(writes[0].body).not.toHaveProperty('position')
  })

  it('shows a 403 phase as unavailable and rejects unconfirmed input', async () => {
    const { handlers } = setup({ forbid: true })
    const view = await handlers.get('z1')
    expect(view.ok && view.value.phases.every((p) => p.status === 'unavailable')).toBe(true)
    expect((await handlers.save({ ...edit('r2', 'a'.repeat(32)), confirmed: false })).ok).toBe(false)
  })
})
