import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { createElement } from 'preact'
import { diffEntries } from '../../../src/zonekeeper/shared/diff'
import type { Change, Entry, Profile } from '../../../src/zonekeeper/shared/model'
import { parseProfile, type RulesSettings } from '../../../src/zonekeeper/shared/schemas'
import { CfClient, type Zone } from '../../../src/zonekeeper/main/cloudflare/client'
import { StaleZoneError, ZoneNotWrittenError } from '../../../src/zonekeeper/main/errors'
import { classifyPageRule, createRulesAdapter, MANAGED_WWW_REF_PREFIX, ownsPageRule, RULES_PHASES } from '../../../src/zonekeeper/main/items/rules'
import { RulesProfile } from '../../../src/zonekeeper/renderer/screens/RulesProfile'

const ZONE: Zone = { id: 'z1', name: 'a.com', account: { id: 'acc1' } }
const FW = 'http_request_firewall_custom'
const REDIR = 'http_request_dynamic_redirect'
const LATE = 'http_request_late_transform'
const RESP = 'http_response_headers_transform'

type Handler = (body: unknown, url: URL) => { status?: number; body?: unknown }
interface Call {
  method: string
  path: string
  body: unknown
}

/** Recorded-shape Cloudflare responses behind the real client. Unrouted requests are a 500. */
function server(routes: Record<string, Handler | { status: number }>) {
  const calls: Call[] = []
  const client = new CfClient({
    getToken: async () => 'tok',
    fetch: (async (input: string, init: RequestInit) => {
      const url = new URL(input)
      const path = url.pathname.replace('/client/v4', '')
      const body = init.body ? JSON.parse(init.body as string) : undefined
      calls.push({ method: init.method ?? 'GET', path, body })
      const route = routes[`${init.method} ${path}`]
      const out = route === undefined ? { status: 500 } : typeof route === 'function' ? route(body, url) : route
      const status = out.status ?? 200
      const ok = status < 400
      return new Response(
        JSON.stringify(
          ok && 'body' in out && (out.body as { envelope?: unknown })?.envelope
            ? (out.body as { envelope: unknown }).envelope
            : { success: ok, result: ok ? (out as { body?: unknown }).body : null, errors: ok ? [] : [{ code: status, message: `HTTP ${status}` }] }
        ),
        { status }
      )
    }) as unknown as typeof fetch
  })
  return { client, calls, writes: () => calls.filter((c) => c.method !== 'GET') }
}

const ok = (body: unknown): Handler => () => ({ body })
const entry = (phase: string, s = 'zones/z1') => `GET /${s}/rulesets/phases/${phase}/entrypoint`
const put = (phase: string, s = 'zones/z1') => `PUT /${s}/rulesets/phases/${phase}/entrypoint`

function emptyZone(): Record<string, Handler | { status: number }> {
  return {
    [entry(FW)]: { status: 404 },
    [entry(REDIR)]: { status: 404 },
    [entry(LATE)]: { status: 404 },
    [entry(RESP)]: { status: 404 },
    'GET /zones/z1/pagerules': ok([])
  }
}

const rule = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  ref: id,
  version: '3',
  last_updated: '2026-01-01T00:00:00Z',
  expression: `(http.host eq "a.com" and id eq "${id}")`,
  action: 'block',
  enabled: true,
  ...extra
})

function settings(over: Partial<RulesSettings> = {}): RulesSettings {
  return {
    phases: { [FW]: [], [REDIR]: [], [LATE]: [], [RESP]: [] } as unknown as RulesSettings['phases'],
    pageRules: [],
    bulkRedirects: [],
    ...over
  }
}
function profile(s: RulesSettings): Profile<RulesSettings> {
  return { id: 'p', item: 'rules', name: 'P', version: 1, zoneIds: ['z1'], settings: s, updatedAt: 't' }
}

const adapter = createRulesAdapter({ sleep: async () => {}, snapshots: { save: async () => 'snap-ref' } })

async function applyDiff(client: CfClient, p: Profile<RulesSettings>, unavailable: string[] = []) {
  const read = await adapter.read(client, ZONE, p)
  const desired = adapter.desired(p, ZONE).filter((e) => !unavailable.includes(e.area))
  const changes = diffEntries(desired, read.entries.filter((e) => !unavailable.includes(e.area)))
  await adapter.apply(client, ZONE, desired, changes, unavailable)
  return { read, desired, changes }
}

describe('phases: read', () => {
  it('confirms the four phases', () => {
    expect([...RULES_PHASES]).toEqual([FW, REDIR, LATE, RESP])
  })

  it('reads a 404 as empty', async () => {
    const { client } = server(emptyZone())
    await expect(adapter.read(client, ZONE, profile(settings()))).resolves.toEqual({ entries: [], unavailable: [], warnings: [] })
  })

  it('reads a 403 as unavailable, per area', async () => {
    const { client } = server({ ...emptyZone(), [entry(LATE)]: { status: 403 } })
    const r = await adapter.read(client, ZONE, profile(settings()))
    expect(r.unavailable).toEqual([LATE])
  })

  it('throws on other errors rather than reading empty', async () => {
    const { client } = server({ ...emptyZone(), [entry(FW)]: { status: 500 } })
    await expect(adapter.read(client, ZONE, profile(settings()))).rejects.toThrow()
  })

  it('throws on a page rules 404: only phase entrypoints mean empty', async () => {
    const { client } = server({ ...emptyZone(), 'GET /zones/z1/pagerules': { status: 404 } })
    await expect(adapter.read(client, ZONE, profile(settings()))).rejects.toThrow()
  })

  it('matches the same rule across zones despite different server ids', async () => {
    const a = server({ ...emptyZone(), [entry(FW)]: ok({ rules: [rule('x', { expression: 'true' })] }) })
    const b = server({ ...emptyZone(), [entry(FW)]: ok({ rules: [rule('y', { expression: 'true' })] }) })
    const [ra, rb] = await Promise.all([adapter.read(a.client, ZONE, profile(settings())), adapter.read(b.client, ZONE, profile(settings()))])
    expect(diffEntries(ra.entries, rb.entries).every((c) => c.type === 'unchanged')).toBe(true)
  })

  describe('keys of rules with the same expression and action', () => {
    const same = (id: string, header: string) => rule(id, { expression: 'true', action: 'rewrite', action_parameters: { headers: { [header]: { operation: 'remove' } } } })
    const wanted = (header: string) => ({ expression: 'true', action: 'rewrite', action_parameters: { headers: { [header]: { operation: 'remove' } } } })
    const withLate = (rules: Array<Record<string, unknown>>) => profile(settings({ phases: { ...settings().phases, [LATE]: rules } as RulesSettings['phases'] }))

  })

})

describe('desired', () => {

  it('refuses a bulk redirect whose source is outside the zone', () => {
    const p = profile(settings({ bulkRedirectList: 'l', bulkRedirects: [{ redirect: { source_url: 'https://b.com/x', target_url: 'https://b.com/y' } }] }))
    expect(() => adapter.desired(p, ZONE)).toThrow(/outside/)
  })

  it('refuses a page rule belonging to another item', () => {
    const p = profile(settings({ pageRules: [{ targets: [], actions: [{ id: 'ssl', value: 'full' }] }] }))
    expect(() => adapter.desired(p, ZONE)).toThrow(/ssl/)
  })
})

describe('phases: apply', () => {
  const profileWith = (phase: string, rules: Array<Record<string, unknown>>) =>
    profile(settings({ phases: { ...settings().phases, [phase]: rules } as RulesSettings['phases'] }))

  it('preserves a URL rewrite in a shared transform phase', async () => {
    const uri = rule('u', { action: 'rewrite', action_parameters: { uri: { path: { value: '/x' } } } })
    const s = server({ ...emptyZone(), [entry(LATE)]: ok({ rules: [uri] }), [put(LATE)]: ok({}) })
    await applyDiff(s.client, profileWith(LATE, [{ expression: 'x', action: 'rewrite', action_parameters: { headers: {} } }]))
    expect((s.writes()[0].body as { rules: Array<{ id?: string }> }).rules[0].id).toBe('u')
  })

  it('never touches an unavailable phase', async () => {
    const s = server({ ...emptyZone(), [entry(FW)]: { status: 403 } })
    await applyDiff(s.client, profile(settings()), [FW])
    expect(s.writes()).toEqual([])
  })

  it('creates the ruleset with POST when the phase has no entrypoint', async () => {
    const s = server({ ...emptyZone(), 'POST /zones/z1/rulesets': ok({}) })
    await applyDiff(s.client, profileWith(FW, [{ expression: 'x', action: 'block' }]))
    expect(s.writes()[0]).toMatchObject({ method: 'POST', body: { kind: 'zone', phase: FW } })
  })

})

describe('page rules', () => {
  const fwd = (url: string) => ({ id: 'forwarding_url', value: { url, status_code: 301 } })
  const target = (v: string) => [{ target: 'url', constraint: { operator: 'matches', value: v } }]
  const pr = (id: string, value: string, priority: number, actions: unknown[] = [fwd('https://a.com/n')]) => ({
    id,
    targets: target(value),
    actions,
    priority,
    status: 'active',
    created_on: 'c',
    modified_on: 'm'
  })

  it('classifies', () => {
    expect(classifyPageRule({ actions: [fwd('x')] })).toBe('rules')
    expect(classifyPageRule({ actions: [{ id: 'ssl', value: 'full' }] })).toBe('ssl')
    expect(classifyPageRule({ actions: [{ id: 'cache_level', value: 'x' }, { id: 'edge_cache_ttl', value: 1 }] })).toBe('caching')
    expect(classifyPageRule({ actions: [{ id: 'ssl', value: 'full' }, { id: 'cache_level', value: 'x' }] })).toBe('rules')
    expect(classifyPageRule({ actions: [{ id: 'unknown_thing' }] })).toBe('rules')
  })

  it('reads only its own, without timestamps or priority, in precedence order', async () => {
    const { client } = server({
      ...emptyZone(),
      'GET /zones/z1/pagerules': ok([pr('low', 'a.com/l', 1), pr('ssl', 'a.com/s', 5, [{ id: 'ssl', value: 'full' }]), pr('high', 'a.com/h', 9)])
    })
    const { entries } = await adapter.read(client, ZONE, profile(settings()))
    expect(entries.map((e) => (e.value as { targets: ReturnType<typeof target> }).targets[0].constraint.value)).toEqual(['a.com/h', 'a.com/l'])
    expect(entries[0].value).toEqual({ targets: target('a.com/h'), actions: [fwd('https://a.com/n')], status: 'active' })
  })

  it('marks a 403 unavailable and never writes it', async () => {
    const s = server({ ...emptyZone(), 'GET /zones/z1/pagerules': { status: 403 } })
    const { read } = await applyDiff(s.client, profile(settings()), ['pageRules'])
    expect(read.unavailable).toEqual(['pageRules'])
    expect(s.writes()).toEqual([])
  })

  it('maps every rule to exactly one owner, and classifyPageRule decides it', () => {
    const ids = ['forwarding_url', 'ssl', 'always_use_https', 'cache_level', 'edge_cache_ttl', 'security_level', 'unknown_thing']
    const sets: string[][] = [[], ...ids.map((a) => [a]), ...ids.flatMap((a) => ids.map((b) => [a, b]))]
    for (const set of sets) {
      const r = { actions: set.map((id) => ({ id })) }
      const owners = (['rules', 'ssl', 'caching'] as const).filter((item) => ownsPageRule(item, r))
      expect(owners).toEqual([classifyPageRule(r)])
    }
    expect(ownsPageRule('ssl', { actions: [{ id: 'ssl' }, { id: 'cache_level' }] })).toBe(false)
    expect(ownsPageRule('caching', { actions: [{ id: 'ssl' }, { id: 'cache_level' }] })).toBe(false)
    expect(ownsPageRule('rules', { actions: [{ id: 'ssl' }, { id: 'cache_level' }] })).toBe(true)
  })

  it('moves a changed rule by POST before any DELETE, so a failed POST loses nothing', async () => {
    const s = server({ ...emptyZone(), 'GET /zones/z1/pagerules': ok([pr('old', 'a.com/e', 2)]), 'POST /zones/z1/pagerules': { status: 400 } })
    await expect(applyDiff(s.client, profile(settings({ pageRules: [{ targets: target('a.com/e'), actions: [fwd('https://{zone}/changed')] }] })))).rejects.toThrow()
    expect(s.writes().some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('reorders by priority PUT, without recreating rules', async () => {
    const s = server({ ...emptyZone(), 'GET /zones/z1/pagerules': ok([pr('x', 'a.com/x', 9), pr('y', 'a.com/y', 2)]), 'PUT /zones/z1/pagerules/x': ok({}), 'PUT /zones/z1/pagerules/y': ok({}) })
    const rule = (v: string) => ({ targets: target(v), actions: [fwd('https://a.com/n')] })
    await applyDiff(s.client, profile(settings({ pageRules: [rule('a.com/y'), rule('a.com/x')] })))
    expect(s.writes().map((c) => [c.path, (c.body as { priority: number }).priority])).toEqual([['/zones/z1/pagerules/y', 9], ['/zones/z1/pagerules/x', 2]])
  })

  it('updates, adds and deletes individually, leaving other items\' rules alone', async () => {
    const other = pr('ssl', 'a.com/s', 5, [{ id: 'ssl', value: 'full' }])
    const s = server({
      ...emptyZone(),
      'GET /zones/z1/pagerules': ok([pr('gone', 'a.com/g', 9), other, pr('edit', 'a.com/e', 2)]),
      'DELETE /zones/z1/pagerules/gone': ok({}),
      'DELETE /zones/z1/pagerules/edit': ok({}),
      'POST /zones/z1/pagerules': ok({})
    })
    await applyDiff(
      s.client,
      profile(settings({ pageRules: [{ targets: target('a.com/e'), actions: [fwd('https://{zone}/changed')] }, { targets: target('a.com/new'), actions: [fwd('https://{zone}/n')] }] }))
    )
    const w = s.writes()
    expect(w.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /zones/z1/pagerules', 'POST /zones/z1/pagerules', 'DELETE /zones/z1/pagerules/gone', 'DELETE /zones/z1/pagerules/edit'])
    const [edit, add] = [w[0].body as { priority: number }, w[1].body as { priority: number }]
    expect(edit.priority).toBeGreaterThan(add.priority)
    expect(JSON.stringify(w)).not.toContain('a.com/s')
  })
})

describe('bulk redirects', () => {
  const LIST = 'redirects_main'
  const item = (id: string, source: string, target = 'https://t.example/') => ({
    id,
    created_on: 'c',
    modified_on: 'm',
    redirect: { source_url: source, target_url: target, status_code: 301, include_subdomains: false, subpath_matching: false, preserve_query_string: false, preserve_path_suffix: true }
  })
  const lists = [
    { id: 'l1', name: LIST, kind: 'redirect' },
    { id: 'l2', name: 'other_list', kind: 'redirect' },
    { id: 'l3', name: 'ips', kind: 'ip' }
  ]
  const brule = { id: 'br', ref: 'br', version: '1', expression: `http.request.full_uri in $${LIST}`, action: 'redirect', enabled: true, action_parameters: { from_list: { name: LIST, key: 'http.request.full_uri' } } }
  const acct = 'accounts/acc1'
  type Row = { id: string; redirect: { source_url: string } & Record<string, unknown> }
  /** A stateful list. `onDuplicate` is what POST does with a source already present: undocumented, so all are tested. */
  function bulk(items: unknown[], more: Record<string, Handler | { status: number }> = {}, onDuplicate: 'upsert' | 'both' | 'refuse' = 'upsert') {
    let rows = [...items] as Row[]
    let nextId = 0
    return {
      ...emptyZone(),
      [`GET /${acct}/rules/lists`]: ok(lists),
      [`GET /${acct}/rules/lists/l1/items`]: () => ({ body: rows }),
      [entry('http_request_redirect', acct)]: ok({ rules: [brule] }),
      [`GET /${acct}/rules/lists/bulk_operations/op`]: ok({ id: 'op', status: 'completed' }),
      [`POST /${acct}/rules/lists/l1/items`]: (body: unknown) => {
        const incoming = body as Row[]
        const dupes = incoming.filter((i) => rows.some((r) => r.redirect.source_url === i.redirect.source_url))
        if (dupes.length > 0 && onDuplicate === 'refuse') return { status: 400 }
        for (const i of incoming) {
          const at = rows.findIndex((r) => r.redirect.source_url === i.redirect.source_url)
          if (at >= 0 && onDuplicate === 'upsert') rows[at] = { ...i, id: rows[at].id }
          else rows.push({ ...i, id: `new${nextId++}` })
        }
        return { body: { operation_id: 'op' } }
      },
      [`PUT /${acct}/rules/lists/l1/items`]: (body: unknown) => {
        rows = (body as Row[]).map((i) => ({ ...i, id: `new${nextId++}` }))
        return { body: { operation_id: 'op' } }
      },
      [`DELETE /${acct}/rules/lists/l1/items`]: (body: unknown) => {
        const ids = (body as { items: Array<{ id: string }> }).items.map((i) => i.id)
        rows = rows.filter((r) => !ids.includes(r.id))
        return { body: { operation_id: 'op' } }
      },
      ...more
    }
  }
  const mine = (over: Partial<RulesSettings> = {}) => profile(settings({ bulkRedirectList: LIST, ...over }))
  const redirect = (source: string, target = 'https://t.example/') => ({ redirect: { source_url: source, target_url: target } })

  it('shares by account', () => {
    expect(adapter.sharedResourceKey?.(ZONE)).toBe('acc1')
    expect(adapter.sharedResourceKey?.({ id: 'z', name: 'n' })).toBeUndefined()
  })

  it('reads only items on the exact zone or www, from the named list only, and warns of skipped subdomains', async () => {
    const s = server(
      bulk([item('1', 'https://a.com/x'), item('2', 'sub.a.com/y'), item('3', 'https://nota.com/z'), item('4', 'https://a.com.evil.net/'), item('5', 'https://b.com/a.com'), item('6', 'www.a.com/w'), item('7', 'https://deep.www.a.com/')])
    )
    const { entries, warnings } = await adapter.read(s.client, ZONE, mine({ bulkRedirects: [redirect('https://a.com/x')] }))
    const sources = entries.flatMap((e) => ((e.value as { redirect?: { source_url: string } }).redirect ? [(e.value as { redirect: { source_url: string } }).redirect.source_url] : []))
    expect(sources).toEqual(['https://a.com/x', 'www.a.com/w'])
    expect(warnings).toHaveLength(1)
    expect(warnings?.[0]).toMatch(/2 .*subdomain/)
    expect(s.calls.some((c) => c.path.includes('/lists/l2'))).toBe(false)
  })

  it('has no warning when no subdomain items exist', async () => {
    const s = server(bulk([item('1', 'https://a.com/x')]))
    const { warnings } = await adapter.read(s.client, ZONE, mine())
    expect(warnings ?? []).toEqual([])
  })

  it('never deletes a subdomain item on Overwrite, and refuses one in desired', async () => {
    const s = server(bulk([item('own', 'https://a.com/gone'), item('sub', 'https://sub.a.com/keep')]))
    await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/n')] }))
    expect(JSON.stringify(s.writes())).not.toContain('sub.a.com')
    expect(s.writes().find((c) => c.method === 'DELETE')?.body).toEqual({ items: [{ id: 'own' }] })
    expect(() => adapter.desired(mine({ bulkRedirects: [redirect('https://sub.a.com/x')] }), ZONE)).toThrow(/outside/)
  })

  it('counts a subdomain item as another zone when refusing to enable a list', async () => {
    const s = server(bulk([item('sub', 'https://sub.a.com/x')], { [entry('http_request_redirect', acct)]: ok({ rules: [] }) }))
    await expect(applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/n')] }))).rejects.toThrow(/other zones/)
    expect(s.writes()).toEqual([])
  })

  describe('a changed item: whole-list PUT', () => {
    const foreign = { ...item('f', 'https://b.com/keep'), comment: 'theirs', future_field: { x: 1 } }
    const sub = item('s', 'https://sub.a.com/keep')
    const edit = item('edit', 'https://a.com/edit', 'https://old/')
    const gone = item('gone', 'https://a.com/gone')
    const changed = mine({ bulkRedirects: [redirect('https://a.com/edit', 'https://new/'), redirect('https://a.com/add')] })
    const bare = ({ id: _i, created_on: _c, modified_on: _m, ...rest }: Record<string, unknown>) => rest

    it('keeps every other item field for field, drops only server fields, and uses no POST or DELETE', async () => {
      const s = server(bulk([foreign, edit, gone, sub]))
      await applyDiff(s.client, changed)
      expect(s.writes().map((c) => c.method)).toEqual(['PUT'])
      const body = s.writes()[0].body as Array<Record<string, unknown>>
      expect(body[0]).toEqual(bare(foreign))
      expect(body[2]).toEqual(bare(sub))
      expect((body[1].redirect as { target_url: string }).target_url).toBe('https://new/')
      expect(body.map((i) => (i.redirect as { source_url: string }).source_url)).toEqual(['https://b.com/keep', 'https://a.com/edit', 'https://sub.a.com/keep', 'https://a.com/add'])
    })

    it('reports a refused PUT with no follow-up writes', async () => {
      const s = server(bulk([edit], { [`PUT /${acct}/rules/lists/l1/items`]: { status: 400 }, [entry('http_request_redirect', acct)]: ok({ rules: [] }), [put('http_request_redirect', acct)]: ok({}) }))
      await expect(applyDiff(s.client, changed)).rejects.toThrow(/https:\/\/a\.com\/edit/)
      expect(s.writes().map((c) => c.method)).toEqual(['PUT'])
    })

    it('reports a failed PUT operation with no follow-up writes', async () => {
      const s = server(bulk([edit], { [`GET /${acct}/rules/lists/bulk_operations/op`]: ok({ status: 'failed', error: 'x' }) }))
      await expect(applyDiff(s.client, changed)).rejects.toThrow(/did not complete/)
      expect(s.writes().map((c) => c.method)).toEqual(['PUT'])
    })

    it('is stale, with no write, when the read just before the PUT differs for this zone', async () => {
      let n = 0
      const s = server(bulk([], { [`GET /${acct}/rules/lists/l1/items`]: () => ({ body: n++ < 2 ? [edit] : [item('edit', 'https://a.com/edit', 'https://other/')] }) }))
      await expect(applyDiff(s.client, changed)).rejects.toBeInstanceOf(StaleZoneError)
      expect(s.writes()).toEqual([])
    })

    it('sends the latest state of other zones from the read just before the PUT', async () => {
      let n = 0
      const late = { ...item('late', 'https://c.com/new'), comment: 'late' }
      let sent: unknown[] | undefined
      const s = server(
        bulk([], {
          [`GET /${acct}/rules/lists/l1/items`]: () => ({ body: sent ?? (n++ < 2 ? [edit] : [edit, late]) }),
          [`PUT /${acct}/rules/lists/l1/items`]: (b: unknown) => {
            sent = b as unknown[]
            return { body: { operation_id: 'op' } }
          }
        })
      )
      await applyDiff(s.client, changed)
      expect(s.writes()[0].body as unknown[]).toContainEqual(bare(late))
    })

    const snapshotter = (fail = false) => {
      const saved: Array<{ accountId: string; listId: string; items: unknown[]; callsAtSave: number }> = []
      return { saved, fail, callCount: () => 0, async save(accountId: string, listId: string, items: unknown[]) {
        if (fail) throw new Error('disk full')
        saved.push({ accountId, listId, items, callsAtSave: 0 })
        return 'snap-ref-1'
      } }
    }
    const run = async (s: ReturnType<typeof server>, snaps: ReturnType<typeof snapshotter>) => {
      const a = createRulesAdapter({ sleep: async () => {}, snapshots: snaps })
      const read = await a.read(s.client, ZONE, changed)
      const d = a.desired(changed, ZONE)
      await a.apply(s.client, ZONE, d, diffEntries(d, read.entries), [])
    }

    it('saves the full list, with ids and other zones, before the PUT', async () => {
      const snaps = snapshotter()
      const s = server(bulk([foreign, edit]))
      let writesAtSave = -1
      const real = snaps.save
      snaps.save = async (...args) => {
        writesAtSave = s.writes().length
        return real(...args)
      }
      await run(s, snaps)
      expect(writesAtSave).toBe(0)
      expect(snaps.saved[0]).toMatchObject({ accountId: 'acc1', listId: 'l1' })
      expect(snaps.saved[0].items).toEqual([foreign, edit])
    })

    it('refuses to write when the snapshot cannot be saved, and says nothing was written', async () => {
      const s = server(bulk([foreign, edit]))
      const err = await run(s, snapshotter(true)).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ZoneNotWrittenError)
      expect((err as Error).message).toMatch(/nothing was written/i)
      expect((err as Error).message).not.toContain('disk full')
      expect(s.writes()).toEqual([])
    })

    it('does not save a snapshot when no whole-list PUT is needed', async () => {
      const snaps = snapshotter()
      const s = server(bulk([]))
      const p = mine({ bulkRedirects: [redirect('https://a.com/add')] })
      const a = createRulesAdapter({ sleep: async () => {}, snapshots: snaps })
      const d = a.desired(p, ZONE)
      await a.apply(s.client, ZONE, d, diffEntries(d, (await a.read(s.client, ZONE, p)).entries), [])
      expect(snaps.saved).toEqual([])
    })

    it('accepts a read-back that differs only in order and server fields', async () => {
      let sent: Array<Record<string, unknown>> | undefined
      const s = server(
        bulk([foreign, edit], {
          [`PUT /${acct}/rules/lists/l1/items`]: (b: unknown) => {
            sent = (b as Array<Record<string, unknown>>).map((x, i) => ({ ...x, id: `n${i}`, created_on: 'x', modified_on: 'y' })).reverse()
            return { body: { operation_id: 'op' } }
          },
          [`GET /${acct}/rules/lists/l1/items`]: () => ({ body: sent ?? [foreign, edit] })
        })
      )
      await expect(run(s, snapshotter())).resolves.toBeUndefined()
    })

  })

  it('does not call a later stale area stale once an earlier area was written', async () => {
    let n = 0
    const s = server(bulk([], {
      [`GET /${acct}/rules/lists/l1/items`]: ok([]),
      [entry(FW)]: () => ({ body: { rules: n++ === 0 ? [rule('a')] : [rule('a'), rule('new')] } })
    }))
    const err = await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/add')] })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(StaleZoneError)
  })

  it('pure additions and removals never use the whole-list PUT', async () => {
    const s = server(bulk([item('gone', 'https://a.com/gone')]))
    await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/add')] }))
    expect(s.writes().map((c) => c.method)).toEqual(['POST', 'DELETE'])
  })

  it('re-reads the account ruleset after polling, so a rule added meanwhile survives the PUT', async () => {
    const added = { id: 'late', ref: 'late', expression: 'http.request.full_uri in $other_list', action: 'redirect', action_parameters: { from_list: { name: 'other_list', key: 'http.request.full_uri' } } }
    let polled = false
    const s = server(
      bulk([], {
        [entry('http_request_redirect', acct)]: () => ({ body: { rules: polled ? [added] : [] } }),
        [`GET /${acct}/rules/lists/bulk_operations/op`]: () => {
          polled = true
          return { body: { status: 'completed' } }
        },
        [put('http_request_redirect', acct)]: ok({})
      })
    )
    await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/n')] }))
    const rules = (s.writes().at(-1)!.body as { rules: Array<{ id?: string }> }).rules
    expect(rules[0].id).toBe('late')
    expect(rules).toHaveLength(2)
  })

  it('makes no account calls when no list is named', async () => {
    const s = server(bulk([]))
    await adapter.read(s.client, ZONE, profile(settings()))
    expect(s.calls.some((c) => c.path.startsWith('/accounts'))).toBe(false)
  })

  it('follows cursors to the last page, so no item is missed', async () => {
    const s = server(
      bulk([], {
        [`GET /${acct}/rules/lists/l1/items`]: (_b, url) =>
          url.searchParams.get('cursor') === 'next'
            ? { body: [item('2', 'https://a.com/2')] }
            : { body: { envelope: { success: true, result: [item('1', 'https://a.com/1')], result_info: { cursors: { after: 'next' } } } } }
      })
    )
    const { entries } = await adapter.read(s.client, ZONE, mine())
    expect(entries.filter((e) => e.key.includes('https://a.com/'))).toHaveLength(2)
  })

  it('reads a 403 on lists, items or the ruleset as unavailable', async () => {
    for (const path of [`GET /${acct}/rules/lists`, `GET /${acct}/rules/lists/l1/items`, entry('http_request_redirect', acct)]) {
      const s = server(bulk([], { [path]: { status: 403 } }))
      const r = await adapter.read(s.client, ZONE, mine())
      expect(r.unavailable).toEqual(['bulkRedirects'])
    }
  })

  it('never writes unavailable bulk redirects', async () => {
    const s = server(bulk([], { [`GET /${acct}/rules/lists`]: { status: 403 } }))
    await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://{zone}/n')] }), ['bulkRedirects'])
    expect(s.writes()).toEqual([])
  })

  it('without a changed item, writes by item and other zones\' items are not sent', async () => {
    const foreign = item('f', 'https://b.com/keep')
    const s = server(bulk([item('gone', 'https://a.com/gone'), foreign]))
    await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://{zone}/add')] }))
    const w = s.writes()
    expect(w.map((c) => c.method)).toEqual(['POST', 'DELETE'])
    expect((w[0].body as Array<{ redirect: { source_url: string } }>).map((i) => i.redirect.source_url)).toEqual(['https://a.com/add'])
    expect(w[1].body).toEqual({ items: [{ id: 'gone' }] })
    expect(JSON.stringify(w)).not.toContain('b.com')
  })

  it('fails when a bulk operation fails', async () => {
    const s = server(bulk([], { [`GET /${acct}/rules/lists/bulk_operations/op`]: ok({ id: 'op', status: 'failed', error: 'nope' }) }))
    await expect(applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/n')] }))).rejects.toThrow(/did not complete/)
  })

  it('waits for a running operation before continuing', async () => {
    let polls = 0
    const s = server(
      bulk([item('gone', 'https://a.com/gone')], { [`GET /${acct}/rules/lists/bulk_operations/op`]: () => ({ body: { id: 'op', status: ++polls < 3 ? 'running' : 'completed' } }) })
    )
    await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/n')] }))
    expect(polls).toBeGreaterThanOrEqual(4)
  })

  it('refuses when an unseen item for this zone appeared', async () => {
    let n = 0
    const s = server(bulk([], { [`GET /${acct}/rules/lists/l1/items`]: () => ({ body: n++ === 0 ? [item('1', 'https://a.com/1')] : [item('1', 'https://a.com/1'), item('2', 'https://a.com/2')] }) }))
    await expect(applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/1'), redirect('https://a.com/3')] }))).rejects.toThrow(/changed/)
    expect(s.writes()).toEqual([])
  })

  it('creates a missing list and enables it with the account ruleset, keeping other rules', async () => {
    const otherRule = { id: 'o', ref: 'o', version: '2', expression: 'http.request.full_uri in $other_list', action: 'redirect', action_parameters: { from_list: { name: 'other_list', key: 'http.request.full_uri' } } }
    const s = server({
      ...emptyZone(),
      [`GET /${acct}/rules/lists`]: ok(lists.slice(1)),
      [entry('http_request_redirect', acct)]: ok({ rules: [otherRule] }),
      [`POST /${acct}/rules/lists`]: ok({ id: 'l1', name: LIST, kind: 'redirect' }),
      [`POST /${acct}/rules/lists/l1/items`]: ok({ operation_id: 'op' }),
      [`GET /${acct}/rules/lists/l1/items`]: ok([item('n', 'https://a.com/n')]),
      [`GET /${acct}/rules/lists/bulk_operations/op`]: ok({ status: 'completed' }),
      [put('http_request_redirect', acct)]: ok({})
    })
    await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/n')] }))
    const w = s.writes()
    expect(w.map((c) => c.method)).toEqual(['POST', 'POST', 'PUT'])
    const rules = (w[2].body as { rules: Array<Record<string, unknown>> }).rules
    expect(rules[0].id).toBe('o')
    expect(rules[1].expression).toBe(`http.request.full_uri in $${LIST}`)
  })

  it('re-enables a disabled list rule, sending every rule', async () => {
    const s = server(bulk([], { [entry('http_request_redirect', acct)]: ok({ rules: [{ ...brule, enabled: false }] }), [put('http_request_redirect', acct)]: ok({}) }))
    await applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/n')] }))
    const last = s.writes().at(-1)!
    expect(last.body).toEqual({ rules: [{ id: 'br', ref: 'br', expression: brule.expression, action: 'redirect', enabled: true, action_parameters: brule.action_parameters }] })
  })

  it('refuses to enable a list holding other zones\' items, before any write', async () => {
    const s = server(bulk([item('f', 'https://b.com/x')], { [entry('http_request_redirect', acct)]: ok({ rules: [] }) }))
    await expect(applyDiff(s.client, mine({ bulkRedirects: [redirect('https://a.com/n')] }))).rejects.toThrow(/other zones/)
    expect(s.writes()).toEqual([])
  })
})

describe('addToProfile', () => {
  const area = FW
  const actual = (key: string, value: unknown, order?: number): Entry => ({ key, area, value, order })

  it('abstracts the zone and inserts at the zone position, without mutating', () => {
    const base = profile(settings({ phases: { ...settings().phases, [FW]: [{ expression: 'first', action: 'block' }, { expression: 'last', action: 'block' }] } }))
    const before = structuredClone(base)
    const out = adapter.addToProfile(base, ZONE, { type: 'extra', actual: actual('k', { expression: '(http.host eq "a.com")', action: 'block', enabled: true }, 1) })
    expect(out.settings.phases[FW].map((r) => r.expression)).toEqual(['first', '(http.host eq "{zone}")', 'last'])
    expect(base).toEqual(before)
  })

  it('replaces the profile rule on a different', () => {
    const base = profile(settings({ phases: { ...settings().phases, [FW]: [{ ref: 'r', expression: 'old', action: 'block' }] } }))
    const [d] = adapter.desired(base, ZONE)
    const change: Change = { type: 'different', desired: d, actual: actual(d.key, { ref: 'r', expression: 'new', action: 'block', enabled: true }, 0) }
    expect(adapter.addToProfile(base, ZONE, change).settings.phases[FW]).toEqual([{ ref: 'r', expression: 'new', action: 'block', enabled: true }])
  })

  it('adopts the zone order on a pure reorder, so the next preview converges', () => {
    const r = (ref: string) => ({ ref, expression: ref, action: 'block', enabled: true })
    let p = profile(settings({ phases: { ...settings().phases, [FW]: [r('b'), r('c'), r('a')] } }))
    const zone: Entry[] = ['a', 'b', 'c'].map((x, order) => ({ key: `${FW}:ref:${x}`, area: FW, value: r(x), order }))
    for (let i = 0; i < 5; i++) {
      const next = diffEntries(adapter.desired(p, ZONE), zone).find((c) => c.type === 'different')
      if (!next) break
      p = adapter.addToProfile(p, ZONE, next)
    }
    expect(p.settings.phases[FW].map((x) => x.ref)).toEqual(['a', 'b', 'c'])
  })

  it('adds a page rule and a bulk redirect', () => {
    const fwd = { targets: [], actions: [{ id: 'forwarding_url', value: { url: 'https://a.com/x', status_code: 301 } }], status: 'active' }
    const p1 = adapter.addToProfile(profile(settings()), ZONE, { type: 'extra', actual: { key: 'pk', area: 'pageRules', value: fwd, order: 0 } })
    expect(JSON.stringify(p1.settings.pageRules)).toContain('https://{zone}/x')
    const value = { list: 'l', redirect: { source_url: 'https://a.com/x', target_url: 'https://a.com/y' } }
    const p2 = adapter.addToProfile(profile(settings({ bulkRedirectList: 'l' })), ZONE, { type: 'extra', actual: { key: 'bk', area: 'bulkRedirects', value } })
    expect(p2.settings.bulkRedirects[0].redirect.source_url).toBe('https://{zone}/x')
    expect((p2.settings.bulkRedirects[0] as Record<string, unknown>).list).toBeUndefined()
  })
})

describe('settings schema', () => {
  const base = { id: 'p', item: 'rules', name: 'P', version: 1, zoneIds: [], updatedAt: 't' }

  it('accepts valid settings', () => {
    expect(() => parseProfile({ ...base, settings: settings() })).not.toThrow()
  })

  it.each([
    ['unknown key', { ...settings(), extra: 1 }],
    ['missing phase', { ...settings(), phases: {} }],
    ['unknown phase', { ...settings(), phases: { ...settings().phases, http_request_transform: [] } }],
    ['excluded ref', { ...settings(), phases: { ...settings().phases, [REDIR]: [{ ref: 'zonekeeper-www-1', expression: 'x', action: 'block' }] } }],
    ['URL rewrite in a transform phase', { ...settings(), phases: { ...settings().phases, [LATE]: [{ expression: 'x', action: 'rewrite', action_parameters: { uri: {} } }] } }],
    ['rule with no expression', { ...settings(), phases: { ...settings().phases, [FW]: [{ action: 'block' }] } }],
    ['items with no list', { ...settings(), bulkRedirects: [{ redirect: { source_url: 'a', target_url: 'b' } }] }]
  ])('rejects %s', (_n, s) => {
    expect(() => parseProfile({ ...base, settings: s })).toThrow()
  })
})

describe('RulesProfile', () => {
  it('renders the rules as JSON and the form', () => {
    const html = renderToStaticMarkup(createElement(RulesProfile, { settings: settings(), onChange: () => {} }))
    expect(html).toContain('Redirect rules')
    expect(html).toContain('textarea')
  })
})
