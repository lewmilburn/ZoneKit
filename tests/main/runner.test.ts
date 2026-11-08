import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CfApiError, type CfClient, type Zone } from '../../src/zonekeeper/main/cloudflare/client'
import { StaleZoneError, UserError, ZoneNotWrittenError } from '../../src/zonekeeper/main/errors'
import { FileProfileStore } from '../../src/zonekeeper/main/store/profileStore'
import type { ItemAdapter, ReadResult } from '../../src/zonekeeper/main/sync/adapter'
import { ProfileSavedError, SyncRunner, type RunnerDeps, type SyncProgress } from '../../src/zonekeeper/main/sync/runner'
import { fileLastSynced } from '../../src/zonekeeper/main/sync/lastSynced'
import type { OverwriteAnswer, SyncPreview } from '../../src/zonekeeper/main/sync/adapter'
import type { Change, Entry, Profile } from '../../src/zonekeeper/shared/model'
import { isPlain } from '../../src/zonekeeper/shared/plain'
import { registerSettingsSchema } from '../../src/zonekeeper/shared/schemas'
import { z } from 'zod'

// These tests use 'rules' as a generic item with a fake adapter, not the real rules settings.
registerSettingsSchema('rules', z.custom((v) => isPlain(v), 'settings must be a JSON object'))

interface Settings {
  entries: Entry[]
}

const e = (key: string, value: unknown = key, area = 'main', order?: number): Entry => ({ key, area, value, order })

const ans = (p: SyncPreview, ...keys: string[]): OverwriteAnswer[] =>
  keys.map((key) => ({ key, hash: p.conflicts.find((c) => c.key === key)!.hash }))

const ZONES: Zone[] = [
  { id: 'z1', name: 'a.com' },
  { id: 'z2', name: 'b.com' },
  { id: 'z3', name: 'c.com' }
]

class FakeAdapter implements ItemAdapter<Settings> {
  item = 'rules' as const
  state = new Map<string, ReadResult | Error>()
  applyError = new Map<string, Error>()
  writes: { zoneId: string; desired: Entry[]; changes: Change[]; unavailable: string[] }[] = []
  reads: string[] = []
  sharedResourceKey?: (zone: Zone) => string | undefined
  onApply?: () => void | Promise<void>
  onRead?: (zoneId: string) => void

  desired(profile: Profile<Settings>): Entry[] {
    return profile.settings.entries
  }

  async read(_client: CfClient, zone: Zone): Promise<ReadResult> {
    this.reads.push(zone.id)
    this.onRead?.(zone.id)
    const s = this.state.get(zone.id)
    if (s instanceof Error) throw s
    return s ?? { entries: [], unavailable: [] }
  }

  async apply(_client: CfClient, zone: Zone, desired: Entry[], changes: Change[], unavailable: string[]): Promise<void> {
    await this.onApply?.()
    const err = this.applyError.get(zone.id)
    if (err) throw err
    // The contract every adapter must meet: nothing handed over touches an unavailable area.
    for (const x of desired) expect(unavailable).not.toContain(x.area)
    for (const c of changes) {
      const area = c.type === 'extra' || c.type === 'different' ? c.actual.area : c.entry.area
      expect(unavailable).not.toContain(area)
    }
    this.writes.push({ zoneId: zone.id, desired, changes, unavailable })
  }

  addToProfile(profile: Profile<Settings>, _zone: Zone, change: Change): Profile<Settings> {
    if (change.type !== 'extra' && change.type !== 'different') throw new Error('not a conflict')
    const rest = profile.settings.entries.filter((x) => x.key !== change.actual.key)
    return { ...profile, settings: { entries: [...rest, change.actual] } }
  }
}

const read = (entries: Entry[], unavailable: string[] = []): ReadResult => ({ entries, unavailable })

let dir: string
let store: FileProfileStore
let adapter: FakeAdapter
let runner: SyncRunner
let client: CfClient
let progress: SyncProgress[]
const CLOCK = new Date('2026-11-06T12:00:00.000Z')

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    store,
    client,
    adapters: { rules: adapter as unknown as ItemAdapter<unknown> },
    now: () => CLOCK,
    onProgress: (p) => progress.push(p),
    ...over
  }
}

async function seed(entries: Entry[], zoneIds = ['z1', 'z2']): Promise<void> {
  await store.save({
    id: 'p1',
    item: 'rules',
    name: 'P1',
    version: 1,
    zoneIds,
    settings: { entries },
    updatedAt: CLOCK.toISOString()
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zk-runner-'))
  store = new FileProfileStore(join(dir, 'profiles.json'))
  adapter = new FakeAdapter()
  client = { listZones: vi.fn(async () => ZONES) } as unknown as CfClient
  progress = []
  runner = new SyncRunner(deps())
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('preview', () => {
  it('builds per-zone changes and lists conflict keys without writing', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', read([e('r1'), e('x')]))
    adapter.state.set('z2', read([]))
    const p = await runner.preview('p1')
    expect(p.zones.map((z) => z.changes.map((c) => c.type))).toEqual([['unchanged', 'extra'], ['add']])
    expect(p.conflictKeys).toEqual(['z1:x'])
    expect(p.canApply).toBe(true)
    expect(adapter.writes).toEqual([])
  })

  it('passes the profile to read, in the preview and in the re-read before apply', async () => {
    await seed([e('r1')], ['z1'])
    const spy = vi.spyOn(adapter, 'read')
    const p = await runner.preview('p1')
    await runner.apply(p.id, [])
    expect(spy).toHaveBeenCalledTimes(2)
    for (const call of spy.mock.calls as unknown[][]) expect((call[2] as Profile<Settings>).id).toBe('p1')
  })

  it('reports StaleZoneError from apply as stale with no write attempted', async () => {
    await seed([e('r1')], ['z1'])
    adapter.applyError.set('z1', new StaleZoneError('Bulk Redirects changed.'))
    const p = await runner.preview('p1')
    const { results } = await runner.apply(p.id, [])
    expect(results[0]).toMatchObject({ status: 'stale', writeAttempted: false, reason: 'Bulk Redirects changed.' })
  })

  it('reports ZoneNotWrittenError as failed with no write attempted', async () => {
    await seed([e('r1')], ['z1'])
    adapter.applyError.set('z1', new ZoneNotWrittenError('Snapshot failed. Nothing was written.'))
    const p = await runner.preview('p1')
    const { results } = await runner.apply(p.id, [])
    expect(results[0]).toMatchObject({ status: 'failed', writeAttempted: false, reason: 'Snapshot failed. Nothing was written.' })
  })

  it('carries an apply failure reason with a snapshot reference into the result', async () => {
    await seed([e('r1')], ['z1'])
    adapter.applyError.set('z1', new UserError('List may be affected. Snapshot: snap-ref-1.'))
    const p = await runner.preview('p1')
    const { results } = await runner.apply(p.id, [])
    expect(results[0].reason).toContain('snap-ref-1')
  })

  it('shows warnings from read in the preview, without carrying them into a later preview', async () => {
    await seed([], ['z1'])
    adapter.state.set('z1', { entries: [e('x')], unavailable: [], warnings: ['old count'] })
    const first = await runner.preview('p1')
    expect(first.zones[0].warnings).toEqual(['old count'])
    adapter.state.set('z1', { entries: [e('x')], unavailable: [], warnings: ['new count'] })
    const second = await runner.addToProfileAndResync(first.id, 'z1:x', 'z1')
    expect(second.zones[0].warnings).toEqual(['new count'])
  })

  it('refuses an unknown profile and releases the lock', async () => {
    await expect(runner.preview('nope')).rejects.toThrow(/no profile/i)
    await seed([])
    await expect(runner.preview('p1')).resolves.toBeDefined()
  })

  it('releases the lock when the zone list cannot be fetched', async () => {
    await seed([])
    ;(client.listZones as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new CfApiError(500, 'bad'))
    await expect(runner.preview('p1')).rejects.toThrow()
    await expect(runner.preview('p1')).resolves.toBeDefined()
  })

  it('marks a zone failed when building desired entries throws', async () => {
    await seed([e('r1')])
    adapter.desired = (): Entry[] => {
      throw new CfApiError(0, 'missing per-zone value')
    }
    const p = await runner.preview('p1')
    expect(p.zones[0].failure).toMatch(/missing per-zone value/)
    expect(p.canApply).toBe(false)
  })

  it('survives a throwing progress listener', async () => {
    await seed([e('r1')])
    runner = new SyncRunner(
      deps({
        onProgress: () => {
          throw new Error('listener')
        }
      })
    )
    const p = await runner.preview('p1')
    expect((await runner.apply(p.id, [])).results).toHaveLength(2)
  })

  it('a read failure blocks apply entirely until a new preview', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', new CfApiError(500, 'server exploded'))
    const p = await runner.preview('p1')
    expect(p.zones[0].failure).toMatch(/server exploded/)
    expect(p.canApply).toBe(false)
    await expect(runner.apply(p.id, [])).rejects.toThrow()
    expect(adapter.writes).toEqual([])
    adapter.state.delete('z1')
    const again = await runner.preview('p1')
    expect(again.canApply).toBe(true)
  })

  it('treats a thrown 403 as a failed zone, not an empty one', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', new CfApiError(403, 'forbidden'))
    const p = await runner.preview('p1')
    expect(p.zones[0].failure).toBeDefined()
    expect(p.zones[0].changes).toEqual([])
    expect(p.canApply).toBe(false)
  })
})

describe('conflict decisions', () => {
  it('apply throws and calls nothing if any conflict is unanswered', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', read([e('r1'), e('x'), e('y')]))
    const p = await runner.preview('p1')
    adapter.reads = []
    await expect(runner.apply(p.id, ans(p, 'z1:x'))).rejects.toThrow(/z1:y/)
    expect(adapter.writes).toEqual([])
    expect(adapter.reads).toEqual([])
  })

  it('refuses an unknown overwrite key, including a non-conflict or another zone', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', read([e('r1'), e('x')]))
    for (const bad of ['z1:nope', 'z2:x', 'x', 'z1:r1']) {
      const p = await runner.preview('p1')
      await expect(runner.apply(p.id, [...ans(p, 'z1:x'), { key: bad, hash: 'h' }])).rejects.toThrow(/unknown/i)
    }
    expect(adapter.writes).toEqual([])
  })

  it('applies when every conflict is answered', async () => {
    await seed([e('r1', 'want')])
    adapter.state.set('z1', read([e('r1', 'have'), e('x')]))
    const p = await runner.preview('p1')
    const { results: res } = await runner.apply(p.id, ans(p, 'z1:r1', 'z1:x'))
    expect(res.map((r) => [r.zoneId, r.status])).toEqual([
      ['z1', 'applied'],
      ['z2', 'applied']
    ])
    expect(adapter.writes[0].changes.map((c) => c.type)).toEqual(['different', 'extra'])
  })

  it('a preview can be applied only once', async () => {
    await seed([e('r1')])
    const p = await runner.preview('p1')
    await runner.apply(p.id, [])
    await expect(runner.apply(p.id, [])).rejects.toThrow(/preview/i)
    expect(adapter.writes).toHaveLength(2)
  })

  it('concurrent apply of the same preview writes once', async () => {
    await seed([e('r1')], ['z1'])
    const p = await runner.preview('p1')
    const [a, b] = await Promise.allSettled([runner.apply(p.id, []), runner.apply(p.id, [])])
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(adapter.writes).toHaveLength(1)
  })

  it('mutating a returned preview does not affect apply', async () => {
    await seed([e('r1')], ['z1'])
    adapter.state.set('z1', read([e('r1'), e('x')]))
    const p = await runner.preview('p1')
    p.zones[0].changes.length = 0
    p.conflictKeys.length = 0
    await expect(runner.apply(p.id, [])).rejects.toThrow(/z1:x/)
  })
})

describe('cancel', () => {
  it('after cancel, apply throws and no write has occurred', async () => {
    await seed([e('r1')])
    const p = await runner.preview('p1')
    runner.cancel(p.id)
    await expect(runner.apply(p.id, [])).rejects.toThrow(/preview/i)
    expect(adapter.writes).toEqual([])
  })

  it('cancel releases the lock and is idempotent', async () => {
    await seed([])
    const p = await runner.preview('p1')
    runner.cancel(p.id)
    runner.cancel(p.id)
    await expect(runner.preview('p1')).resolves.toBeDefined()
  })

  it('cancel during apply refuses clearly and keeps the lock until apply ends', async () => {
    await seed([e('r1')], ['z1'])
    const p = await runner.preview('p1')
    let finish!: () => void
    adapter.onApply = () => new Promise<void>((r) => (finish = r))
    const running = runner.apply(p.id, [])
    await vi.waitFor(() => expect(finish).toBeDefined())
    await expect(runner.cancel(p.id)).rejects.toThrow(/in progress/i)
    await expect(runner.preview('p1')).rejects.toThrow(/already/i)
    finish()
    await running
    await expect(runner.preview('p1')).resolves.toBeDefined()
  })
})

describe('addToProfileAndResync', () => {
  it('saves the profile and the new preview shows the entry as add on other zones', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', read([e('r1'), e('x')]))
    adapter.state.set('z2', read([e('r1')]))
    const p = await runner.preview('p1')
    const next = await runner.addToProfileAndResync(p.id, 'x', 'z1')
    expect(next.id).not.toBe(p.id)
    expect(next.profileVersion).toBe(2)
    expect(((await store.get('p1'))!.settings as Settings).entries.map((x) => x.key)).toEqual(['r1', 'x'])
    expect(next.zones[0].changes.map((c) => c.type)).toEqual(['unchanged', 'unchanged'])
    expect(next.zones[1].changes.map((c) => c.type)).toEqual(['unchanged', 'add'])
    expect(next.conflictKeys).toEqual([])
    await expect(runner.apply(p.id, [])).rejects.toThrow(/preview/i)
  })

  it('accepts the composite conflict key too', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x')]))
    const p = await runner.preview('p1')
    const next = await runner.addToProfileAndResync(p.id, 'z1:x', 'z1')
    expect(next.profileVersion).toBe(2)
  })

  it('returns findZoneLiterals output as warnings on the source zone', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x', { expr: 'host eq "api.a.com"' })]))
    const p = await runner.preview('p1')
    const next = await runner.addToProfileAndResync(p.id, 'x', 'z1')
    expect(next.zones[0].warnings).toEqual(['host eq "api.a.com"'])
    expect(next.zones[1].warnings).toEqual([])
  })

  it('refuses a key that is not a conflict in that zone, saves nothing, releases the lock', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', read([e('r1'), e('x')]))
    const p = await runner.preview('p1')
    await expect(runner.addToProfileAndResync(p.id, 'r1', 'z1')).rejects.toThrow(/conflict/i)
    expect((await store.get('p1'))!.version).toBe(1)
    await expect(runner.preview('p1')).resolves.toBeDefined()
  })

  it('refuses when the profile changed since the preview', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x')]))
    const p = await runner.preview('p1')
    await store.save({ ...(await store.get('p1'))!, name: 'Edited' })
    await expect(runner.addToProfileAndResync(p.id, 'x', 'z1')).rejects.toThrow(/changed/i)
    expect((await store.get('p1'))!.version).toBe(2)
  })

  it('releases the lock when the save fails', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x')]))
    const p = await runner.preview('p1')
    const save = vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk'))
    await expect(runner.addToProfileAndResync(p.id, 'x', 'z1')).rejects.toThrow('disk')
    save.mockRestore()
    await expect(runner.preview('p1')).resolves.toBeDefined()
  })

  it('refuses an adapter result for a different profile', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x')]))
    adapter.addToProfile = (profile) => ({ ...profile, id: 'other' })
    const p = await runner.preview('p1')
    await expect(runner.addToProfileAndResync(p.id, 'x', 'z1')).rejects.toThrow(/different profile/i)
    expect(await store.get('other')).toBeUndefined()
  })
})

describe('apply safety', () => {
  it('one zone failing leaves others applied, each with its own result', async () => {
    await seed([e('r1')], ['z1', 'z2', 'z3'])
    adapter.applyError.set('z2', new CfApiError(500, 'boom'))
    const p = await runner.preview('p1')
    const { results: res } = await runner.apply(p.id, [])
    expect(res.map((r) => r.status)).toEqual(['applied', 'failed', 'applied'])
    expect(res[1].reason).toMatch(/boom/)
    expect(res[1].writeAttempted).toBe(true)
    expect(adapter.writes.map((w) => w.zoneId)).toEqual(['z1', 'z3'])
  })

  it.each([
    [401, /sign-in.*expired/i],
    [403, /revoked|permission/i]
  ])('a %i during apply fails only that zone with a clear reason', async (status, re) => {
    await seed([e('r1')])
    adapter.applyError.set('z1', new CfApiError(status, 'raw'))
    const p = await runner.preview('p1')
    const { results: res } = await runner.apply(p.id, [])
    expect(res[0].status).toBe('failed')
    expect(res[0].reason).toMatch(re)
    expect(res[1].status).toBe('applied')
  })

  it('a zone changed since preview returns stale and is not written; others proceed', async () => {
    await seed([e('r1')])
    const p = await runner.preview('p1')
    adapter.state.set('z1', read([e('new-rule')]))
    const { results: res } = await runner.apply(p.id, [])
    expect(res.map((r) => r.status)).toEqual(['stale', 'applied'])
    expect(adapter.writes.map((w) => w.zoneId)).toEqual(['z2'])
  })

  it('an unchanged-looking zone that drifted is stale, not unchanged', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', read([e('r1')]))
    const p = await runner.preview('p1')
    adapter.state.set('z1', read([e('r1'), e('x')]))
    const { results: res } = await runner.apply(p.id, [])
    expect(res[0].status).toBe('stale')
  })

  it('a reorder since preview is stale', async () => {
    await seed([e('a', 'a', 'main', 1), e('b', 'b', 'main', 2)], ['z1'])
    adapter.state.set('z1', read([e('a', 'a', 'main', 1), e('b', 'b', 'main', 2)]))
    const p = await runner.preview('p1')
    adapter.state.set('z1', read([e('a', 'a', 'main', 2), e('b', 'b', 'main', 1)]))
    expect((await runner.apply(p.id, [])).results[0].status).toBe('stale')
  })

  it('an area becoming unavailable or available since preview is stale', async () => {
    await seed([e('r1')], ['z1', 'z2'])
    adapter.state.set('z2', read([], ['other']))
    const p = await runner.preview('p1')
    adapter.state.set('z1', read([], ['main']))
    adapter.state.set('z2', read([]))
    const { results: res } = await runner.apply(p.id, [])
    expect(res.map((r) => r.status)).toEqual(['stale', 'stale'])
    expect(adapter.writes).toEqual([])
  })

  it('passes changes from the re-read so server ids are current', async () => {
    await seed([], ['z1'])
    adapter.state.set('z1', read([e('x', { id: 'old', body: 1 })]))
    const p = await runner.preview('p1')
    adapter.state.set('z1', read([e('x', { id: 'recreated', body: 1 })]))
    const { results: res } = await runner.apply(p.id, ans(p, 'z1:x'))
    expect(res[0].status).toBe('applied')
    expect((adapter.writes[0].changes[0] as { actual: Entry }).actual.value).toEqual({ id: 'recreated', body: 1 })
  })

  it('a zone with no changes is not written and returns unchanged', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', read([e('r1')]))
    const p = await runner.preview('p1')
    const { results: res } = await runner.apply(p.id, [])
    expect(res[0].status).toBe('unchanged')
    expect(adapter.writes.map((w) => w.zoneId)).toEqual(['z2'])
  })

  it('refuses entirely when the profile version changed, writing nothing', async () => {
    await seed([e('r1')])
    const p = await runner.preview('p1')
    await store.save({ ...(await store.get('p1'))!, name: 'Edited' })
    await expect(runner.apply(p.id, [])).rejects.toThrow(/changed/i)
    expect(adapter.writes).toEqual([])
    await expect(runner.preview('p1')).resolves.toBeDefined()
  })

  it('refuses when the profile was deleted', async () => {
    await seed([e('r1')])
    const p = await runner.preview('p1')
    await store.delete('p1')
    await expect(runner.apply(p.id, [])).rejects.toThrow(/changed|no longer/i)
    expect(adapter.writes).toEqual([])
  })

  it('a profile edited during apply stops later zones being written, as stale', async () => {
    await seed([e('r1')], ['z1'])
    const p = await runner.preview('p1')
    const realRead = adapter.read.bind(adapter)
    adapter.read = async (c, z) => {
      const r = await realRead(c, z)
      await store.save({ ...(await store.get('p1'))!, name: 'Edited' })
      return r
    }
    const { results: res } = await runner.apply(p.id, [])
    expect(res[0].status).toBe('stale')
    expect(adapter.writes).toEqual([])
  })

  it('writes at most 8 zones at once', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `m${i}.com` }))
    ;(client.listZones as ReturnType<typeof vi.fn>).mockResolvedValue(many)
    await seed([e('r1')], many.map((z) => z.id))
    const p = await runner.preview('p1')
    let active = 0
    let peak = 0
    adapter.onApply = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
    }
    await runner.apply(p.id, [])
    expect(peak).toBe(8)
    // A starting report, then one per zone
    expect(progress.filter((x) => x.phase === 'apply')).toHaveLength(13)
  })
})

describe('unavailable areas', () => {
  it('lists the area, and neither desired nor changes reach the adapter for it', async () => {
    await seed([e('keep'), e('locked', 'want', 'paid')], ['z1'])
    adapter.state.set('z1', read([e('stray', 's', 'paid')], ['paid']))
    const p = await runner.preview('p1')
    expect(p.zones[0].unavailable).toEqual(['paid'])
    expect(p.conflictKeys).toEqual([])
    expect(p.zones[0].changes.map((c) => c.type)).toEqual(['add'])
    await runner.apply(p.id, [])
    const w = adapter.writes[0]
    expect(w.desired.map((x) => x.key)).toEqual(['keep'])
    expect(w.changes).toEqual([{ type: 'add', entry: e('keep') }])
  })

  it('a zone whose only desired entries are in an unavailable area is unchanged', async () => {
    await seed([e('locked', 'want', 'paid')], ['z1'])
    adapter.state.set('z1', read([], ['paid']))
    const p = await runner.preview('p1')
    expect((await runner.apply(p.id, [])).results[0].status).toBe('unchanged')
    expect(adapter.writes).toEqual([])
  })
})

describe('concurrency lock', () => {
  it('a second concurrent sync on one profile is refused while preview is running', async () => {
    await seed([])
    const first = runner.preview('p1')
    await expect(runner.preview('p1')).rejects.toThrow(/already/i)
    await first
  })

  it('an open preview holds the lock until apply finishes, even after an error', async () => {
    await seed([e('r1')])
    adapter.state.set('z1', read([e('r1'), e('x')]))
    const p = await runner.preview('p1')
    await expect(runner.preview('p1')).rejects.toThrow(/already/i)
    await expect(runner.apply(p.id, [])).rejects.toThrow()
    await expect(runner.preview('p1')).resolves.toBeDefined()
  })

  it('different profiles may sync together', async () => {
    await seed([], ['z1'])
    await store.save({ id: 'p2', item: 'rules', name: 'P2', version: 1, zoneIds: ['z2'], settings: { entries: [] }, updatedAt: CLOCK.toISOString() })
    await expect(Promise.all([runner.preview('p1'), runner.preview('p2')])).resolves.toHaveLength(2)
  })
})

describe('results', () => {
  it('never carry a token from an unexpected error, and survive IPC cloning', async () => {
    await seed([e('r1')], ['z1'])
    adapter.applyError.set('z1', new Error('fetch failed Bearer SECRET-TOKEN'))
    const p = await runner.preview('p1')
    const out = structuredClone(await runner.apply(p.id, []))
    expect(out.results.map((r) => r.status)).toEqual(['failed'])
    expect(JSON.stringify(out)).not.toContain('SECRET-TOKEN')
  })
})

describe('review fixes', () => {
  it('I1: results list skipped areas on unchanged and applied zones', async () => {
    await seed([e('keep'), e('locked', 'want', 'paid')], ['z1', 'z2'])
    adapter.state.set('z1', read([e('keep')], ['paid']))
    adapter.state.set('z2', read([], ['paid']))
    const p = await runner.preview('p1')
    const { results } = await runner.apply(p.id, [])
    expect(results.map((r) => [r.status, r.unavailable])).toEqual([
      ['unchanged', ['paid']],
      ['applied', ['paid']]
    ])
  })

  it('I2: apply receives unavailable, so a whole-phase write skips that area', async () => {
    await seed([e('keep')], ['z1'])
    adapter.state.set('z1', read([], ['paid']))
    const written: string[] = []
    const realApply = adapter.apply.bind(adapter)
    adapter.apply = async (c, z, desired, changes, unavailable) => {
      for (const area of ['main', 'paid']) if (!unavailable.includes(area)) written.push(area)
      return realApply(c, z, desired, changes, unavailable)
    }
    const p = await runner.preview('p1')
    await runner.apply(p.id, [])
    expect(written).toEqual(['main'])
    expect(adapter.writes[0].unavailable).toEqual(['paid'])
  })

  describe('I3: shared resources', () => {
    const logWrites = (log: string[]): void => {
      adapter.onRead = (id) => log.push(`read ${id}`)
      const realApply = adapter.apply.bind(adapter)
      adapter.apply = async (c, z, d, ch, u) => {
        log.push(`start ${z.id}`)
        await new Promise((r) => setTimeout(r, 2))
        await realApply(c, z, d, ch, u)
        log.push(`end ${z.id}`)
      }
    }

    it('zones with the same key run one at a time, re-reading before each write', async () => {
      await seed([e('r1')])
      adapter.sharedResourceKey = () => 'acct'
      const p = await runner.preview('p1')
      const log: string[] = []
      logWrites(log)
      await runner.apply(p.id, [])
      expect(log).toEqual(['read z1', 'start z1', 'end z1', 'read z2', 'start z2', 'end z2'])
    })

    it('the key also serialises different profiles', async () => {
      await seed([e('r1')], ['z1'])
      await store.save({ id: 'p2', item: 'rules', name: 'P2', version: 1, zoneIds: ['z2'], settings: { entries: [e('r1')] }, updatedAt: CLOCK.toISOString() })
      adapter.sharedResourceKey = () => 'acct'
      const [a, b] = await Promise.all([runner.preview('p1'), runner.preview('p2')])
      const log: string[] = []
      logWrites(log)
      await Promise.all([runner.apply(a.id, []), runner.apply(b.id, [])])
      expect(log).toEqual(['read z1', 'start z1', 'end z1', 'read z2', 'start z2', 'end z2'])
    })

    it('a failing zone does not block the next one on that key', async () => {
      await seed([e('r1')])
      adapter.sharedResourceKey = () => 'acct'
      adapter.applyError.set('z1', new CfApiError(500, 'boom'))
      const p = await runner.preview('p1')
      const { results } = await runner.apply(p.id, [])
      expect(results.map((r) => r.status)).toEqual(['failed', 'applied'])
    })

    it('a throwing key function fails that zone without a write', async () => {
      await seed([e('r1')], ['z1'])
      const p = await runner.preview('p1')
      adapter.sharedResourceKey = () => {
        throw new Error('bad key')
      }
      const { results } = await runner.apply(p.id, [])
      expect(results[0]).toMatchObject({ status: 'failed', writeAttempted: false })
      expect(adapter.writes).toEqual([])
    })
  })

  describe('I4: preview expiry', () => {
    let t: number
    beforeEach(() => {
      t = CLOCK.getTime()
      runner = new SyncRunner(deps({ now: () => new Date(t) }))
    })
    const MIN = 60_000

    it('an abandoned preview stops blocking after 30 minutes, not before', async () => {
      await seed([])
      const old = await runner.preview('p1')
      t += 29 * MIN
      await expect(runner.preview('p1')).rejects.toThrow(/already/i)
      t += MIN
      const next = await runner.preview('p1')
      await expect(runner.apply(old.id, [])).rejects.toThrow(/preview/i)
      expect(next.id).not.toBe(old.id)
    })

    it('an expired preview cannot be applied and releases the lock', async () => {
      await seed([e('r1')])
      const p = await runner.preview('p1')
      t += 30 * MIN
      await expect(runner.apply(p.id, [])).rejects.toThrow(/expired/i)
      expect(adapter.writes).toEqual([])
      await expect(runner.preview('p1')).resolves.toBeDefined()
    })

    it('never expires during an active apply', async () => {
      await seed([e('r1')], ['z1'])
      const p = await runner.preview('p1')
      let finish!: () => void
      adapter.onApply = () => new Promise<void>((r) => (finish = r))
      const running = runner.apply(p.id, [])
      await vi.waitFor(() => expect(finish).toBeDefined())
      t += 120 * MIN
      await expect(runner.preview('p1')).rejects.toThrow(/already/i)
      finish()
      expect((await running).results[0].status).toBe('applied')
    })
  })

  it('I5 and chained adds: warnings and decisions accumulate across adds', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x', 'host api.a.com')]))
    adapter.state.set('z2', read([e('y', 'host api.b.com')]))
    const p = await runner.preview('p1')
    const second = await runner.addToProfileAndResync(p.id, 'x', 'z1')
    const third = await runner.addToProfileAndResync(second.id, 'y', 'z2')
    expect(third.profileVersion).toBe(3)
    expect(third.zones[0].warnings).toEqual(['host api.a.com'])
    expect(third.zones[1].warnings).toEqual(['host api.b.com'])
  })

  it('adding a different change copies the zone value into the profile', async () => {
    await seed([e('r1', 'old')])
    adapter.state.set('z1', read([e('r1', 'new')]))
    adapter.state.set('z2', read([e('r1', 'old')]))
    const p = await runner.preview('p1')
    const next = await runner.addToProfileAndResync(p.id, 'r1', 'z1')
    expect(next.zones[0].changes.map((c) => c.type)).toEqual(['unchanged'])
    expect(next.conflictKeys).toEqual(['z2:r1'])
  })

  it('the same key on two zones is two conflicts, and each add flips the other', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x', 1)]))
    adapter.state.set('z2', read([e('x', 2)]))
    const p = await runner.preview('p1')
    expect(p.conflictKeys).toEqual(['z1:x', 'z2:x'])
    const a = await runner.addToProfileAndResync(p.id, 'x', 'z1')
    expect(a.conflictKeys).toEqual(['z2:x'])
    const b = await runner.addToProfileAndResync(a.id, 'x', 'z2')
    expect(b.conflictKeys).toEqual(['z1:x'])
    expect(((await store.get('p1'))!.settings as Settings).entries[0].value).toBe(2)
  })

  describe('I6: answers are bound to content', () => {
    it('hashes are stable for the same conflict and ignore server fields', async () => {
      await seed([], ['z1'])
      adapter.state.set('z1', read([e('x', { id: 'a', body: 1 })]))
      const p = await runner.preview('p1')
      await runner.cancel(p.id)
      adapter.state.set('z1', read([e('x', { body: 1, id: 'b' })]))
      const q = await runner.preview('p1')
      expect(q.conflicts).toEqual(p.conflicts)
    })

    it('an answer survives a resync only if its conflict is unchanged', async () => {
      await seed([])
      adapter.state.set('z1', read([e('x', 1), e('other', 'o')]))
      adapter.state.set('z2', read([e('x', 2), e('y', 'y')]))
      const p = await runner.preview('p1')
      const oldAnswers = ans(p, 'z2:x', 'z2:y')
      const next = await runner.addToProfileAndResync(p.id, 'x', 'z1')
      // z2:x went from extra to different, so the old answer no longer applies.
      const fresh = ans(next, 'z1:other', 'z2:x', 'z2:y')
      expect(fresh.find((a) => a.key === 'z2:y')).toEqual(oldAnswers[1])
      await expect(
        runner.apply(next.id, [fresh[0], oldAnswers[0], oldAnswers[1]])
      ).rejects.toThrow(/new answer: z2:x\./i)
      expect(adapter.writes).toEqual([])
    })

    it('accepts carried answers whose content is unchanged', async () => {
      await seed([])
      adapter.state.set('z1', read([e('x', 1)]))
      adapter.state.set('z2', read([e('y', 'y')]))
      const p = await runner.preview('p1')
      const carried = ans(p, 'z2:y')
      const next = await runner.addToProfileAndResync(p.id, 'x', 'z1')
      const { results } = await runner.apply(next.id, carried)
      expect(results.map((r) => r.status)).toEqual(['unchanged', 'applied'])
    })
  })

  describe('I8: cancel during add', () => {
    const gatedSave = (): (() => void) => {
      let open!: () => void
      const gate = new Promise<void>((r) => (open = r))
      const realSave = store.save.bind(store)
      vi.spyOn(store, 'save').mockImplementationOnce(async (x) => {
        await gate
        return realSave(x)
      })
      return open
    }

    it('waits for the add, then cancels and reports that the profile was saved', async () => {
      await seed([])
      adapter.state.set('z1', read([e('x')]))
      const p = await runner.preview('p1')
      const release = gatedSave()
      const add = runner.addToProfileAndResync(p.id, 'x', 'z1')
      let cancelled = false
      const cancel = runner.cancel(p.id).then((o) => ((cancelled = true), o))
      await new Promise((r) => setTimeout(r, 5))
      expect(cancelled).toBe(false)
      release()
      expect(await cancel).toEqual({ cancelled: true, profileSaved: true })
      const next = await add
      await expect(runner.apply(next.id, [])).rejects.toThrow(/preview/i)
      expect((await store.get('p1'))!.version).toBe(2)
      await expect(runner.preview('p1')).resolves.toBeDefined()
    })

    it('reports profileSaved false when the add saved nothing', async () => {
      await seed([])
      adapter.state.set('z1', read([e('x')]))
      const p = await runner.preview('p1')
      const add = runner.addToProfileAndResync(p.id, 'nope', 'z1')
      const cancel = runner.cancel(p.id)
      await expect(add).rejects.toThrow(/conflict/i)
      expect(await cancel).toEqual({ cancelled: true, profileSaved: false })
    })

    it('cancel reports earlier adds as saved, and an unknown id as not cancelled', async () => {
      await seed([])
      adapter.state.set('z1', read([e('x')]))
      const p = await runner.preview('p1')
      const next = await runner.addToProfileAndResync(p.id, 'x', 'z1')
      expect(await runner.cancel(next.id)).toEqual({ cancelled: true, profileSaved: true })
      expect(await runner.cancel(next.id)).toEqual({ cancelled: false, profileSaved: false })
    })
  })

  it('I9: a failed rebuild says the profile was saved, and the next preview keeps its warnings and decisions', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x', 'host api.a.com')]))
    const p = await runner.preview('p1')
    ;(client.listZones as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new CfApiError(500, 'zones down'))
    const err = await runner.addToProfileAndResync(p.id, 'x', 'z1').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(ProfileSavedError)
    expect((err as Error).message).toMatch(/profile was saved.*zones down/i)
    expect((await store.get('p1'))!.version).toBe(2)
    const retry = await runner.preview('p1')
    expect(retry.zones[0].warnings).toEqual(['host api.a.com'])
  })

  it('never exposes a token from an unexpected read error in a preview', async () => {
    await seed([e('r1')], ['z1'])
    adapter.state.set('z1', new Error('Bearer SECRET-TOKEN'))
    const p = await runner.preview('p1')
    expect(JSON.stringify(p)).not.toContain('SECRET-TOKEN')
  })

  it('refuses a wrong-zone key on add', async () => {
    await seed([])
    adapter.state.set('z1', read([e('x')]))
    const p = await runner.preview('p1')
    await expect(runner.addToProfileAndResync(p.id, 'x', 'z2')).rejects.toThrow(/not a conflict/i)
  })
})

describe('last synced', () => {
  const withLastSynced = (): SyncRunner => new SyncRunner(deps({ lastSynced: fileLastSynced(join(dir, 'last-synced.json')) }))

  it('a zone still holding what the profile last wrote is a change, not a conflict', async () => {
    runner = withLastSynced()
    await seed([e('s1', 'on')], ['z1', 'z2'])
    adapter.state.set('z1', read([e('s1', 'on')]))
    adapter.state.set('z2', read([e('s1', 'on')]))
    await runner.apply((await runner.preview('p1')).id, [])
    // The profile changes, z1 kept the old value, z2 was changed by hand
    await store.save({ ...(await store.get('p1'))!, settings: { entries: [e('s1', 'off')] } })
    adapter.state.set('z2', read([e('s1', 'other')]))
    const p = await runner.preview('p1')
    expect(p.zones[0].changes[0]).toMatchObject({ type: 'different', expected: true })
    expect(p.conflictKeys).toEqual(['z2:s1'])
  })

  it('without a record of the last sync every difference is a conflict', async () => {
    runner = withLastSynced()
    await seed([e('s1', 'off')], ['z1'])
    adapter.state.set('z1', read([e('s1', 'on')]))
    expect((await runner.preview('p1')).conflictKeys).toEqual(['z1:s1'])
  })

  it('a removed entry the profile last wrote is removed without asking', async () => {
    runner = withLastSynced()
    await seed([e('r1')], ['z1'])
    adapter.state.set('z1', read([e('r1')]))
    await runner.apply((await runner.preview('p1')).id, [])
    await store.save({ ...(await store.get('p1'))!, settings: { entries: [] } })
    const p = await runner.preview('p1')
    expect(p.zones[0].changes[0]).toMatchObject({ type: 'extra', owned: true })
    expect(p.conflictKeys).toEqual([])
  })
})
