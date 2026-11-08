import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileProfileStore } from '../../src/zonekeeper/main/store/profileStore'
import { applyImport, exportProfiles, parseImport } from '../../src/zonekeeper/main/store/transfer'
import type { ItemKind, Profile } from '../../src/zonekeeper/shared/model'
import { isPlain } from '../../src/zonekeeper/shared/plain'
import { registerSettingsSchema } from '../../src/zonekeeper/shared/schemas'
import { z } from 'zod'

// These tests use 'rules' as a generic item, not the real rules settings.
registerSettingsSchema('rules', z.custom((v) => isPlain(v), 'settings must be a JSON object'))

const p = (id: string, zoneIds: string[] = [], item: ItemKind = 'rules', extra: object = {}): Profile<unknown> => ({
  id,
  item,
  name: `Profile ${id}`,
  version: 1,
  zoneIds,
  settings: { a: 1 },
  updatedAt: '2026-11-06T00:00:00.000Z',
  ...extra
})

const envelope = (profiles: unknown[], formatVersion: unknown = 1): string =>
  JSON.stringify({ formatVersion, profiles })

let dir: string
let a: FileProfileStore
let b: FileProfileStore
let bFile: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zk-transfer-'))
  a = new FileProfileStore(join(dir, 'a.json'))
  bFile = join(dir, 'b.json')
  b = new FileProfileStore(bFile)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('exportProfiles', () => {
  it('writes formatVersion 1 and the requested profiles', async () => {
    await a.save(p('x', ['z1']))
    await a.save(p('y', ['z2']))
    const out = JSON.parse(await exportProfiles(a, ['x']))
    expect(out.formatVersion).toBe(1)
    expect(out.profiles.map((q: Profile<unknown>) => q.id)).toEqual(['x'])
  })

  it('never contains token or auth fields, even if a profile object has one', async () => {
    await a.save(p('x', ['z1']))
    const real = a.get.bind(a)
    a.get = async (id) => ({ ...(await real(id))!, token: 'SECRET-TOKEN', authorization: 'Bearer SECRET-TOKEN' }) as Profile<unknown>
    const text = await exportProfiles(a, ['x'])
    expect(text).not.toContain('SECRET-TOKEN')
    expect(text).not.toMatch(/token|authorization/i)
  })

  it('saves, exports and imports header rules named Authorization, Cookie and Set-Cookie', async () => {
    const settings = { headers: { Authorization: 'pass', Cookie: 'remove', 'Set-Cookie': 'set', 'X-Api-Key': 'remove' } }
    const saved = await a.save({ ...p('x', ['z1']), settings })
    const preview = await parseImport(b, await exportProfiles(a, ['x']))
    await applyImport(b, preview, [])
    expect((await b.get('x'))?.settings).toEqual(saved.settings)
  })

  it('refuses to save a __proto__ key, so a hand-built preview cannot store one', async () => {
    const settings = JSON.parse('{"__proto__":{"polluted":1}}')
    await expect(a.save({ ...p('x', ['z1']), settings })).rejects.toThrow(/__proto__/)
    expect(await a.list('rules')).toEqual([])
  })

  it('throws for an unknown id', async () => {
    await expect(exportProfiles(a, ['missing'])).rejects.toThrow(/missing/)
  })

})

describe('parseImport', () => {
  it('lists an existing ID in replaced', async () => {
    const existing = await b.save(p('x', ['z1']))
    const incoming = p('x', ['z1', 'z2'])
    const preview = await parseImport(b, envelope([incoming]))
    expect(preview.added).toEqual([])
    expect(preview.replaced).toEqual([{ existing, incoming }])
    expect(preview.zoneClashes).toEqual([])
  })

  it('does not call a replaced profile its own clash', async () => {
    await b.save(p('x', ['z1']))
    const preview = await parseImport(b, envelope([p('x', ['z1'])]))
    expect(preview.zoneClashes).toEqual([])
  })

  it('does not change the store', async () => {
    await parseImport(b, envelope([p('x', ['z1'])]))
    expect(await b.list('rules')).toEqual([])
  })

  const refused: Array<[string, string, RegExp]> = [
    ['malformed JSON', '{nope', /json/i],
    ['a non-object', '[]', /shape|invalid/i],
    ['a wrong shape', envelope([{ id: 5 }]), /invalid/i],
    ['a missing profiles list', JSON.stringify({ formatVersion: 1 }), /invalid/i],
    ['a newer formatVersion', envelope([], 2), /newer/i],
    ['a missing formatVersion', JSON.stringify({ profiles: [] }), /formatVersion|invalid/i],
    ['an unknown top-level profile field', envelope([{ ...p('x'), token: 'abc' }]), /invalid|unrecognized/i],
    ['an unknown envelope field', JSON.stringify({ formatVersion: 1, profiles: [], token: 'abc' }), /invalid|unrecognized/i],
    ['an unknown item', envelope([{ ...p('x'), item: 'dns' }]), /invalid/i],
    ['a non-object settings value', envelope([{ ...p('x'), settings: [1] }]), /invalid/i],
    ['duplicate zones in a profile', envelope([p('x', ['z1', 'z1'])]), /invalid|duplicate/i],
    ['duplicate profile IDs', envelope([p('x'), p('x')]), /duplicate/i],
    ['a __proto__ key', '{"formatVersion":1,"profiles":[{"id":"x","item":"rules","name":"n","version":1,"zoneIds":[],"settings":{"__proto__":{"polluted":1}},"updatedAt":"t"}]}', /__proto__/],
    ['a constructor key', envelope([p('x', [], 'rules', { settings: { deep: [{ constructor: {} }] } })]), /constructor/],
    ['a prototype key', envelope([p('x', [], 'rules', { settings: { prototype: 1 } })]), /prototype/],
    ['a same-ID profile with a different item', envelope([p('keep', ['zk'], 'ssl')]), /item/i]
  ]
  it.each(refused)('refuses %s with a message and leaves the store unchanged', async (_n, text, msg) => {
    await b.save(p('keep', ['zk']))
    await expect(parseImport(b, text)).rejects.toThrow(msg)
    expect((await b.list('rules')).map((x) => x.id)).toEqual(['keep'])
  })

  it('refuses input over 10 MB', async () => {
    const big = envelope([p('x', [], 'rules', { name: 'a'.repeat(10 * 1024 * 1024) })])
    await expect(parseImport(b, big)).rejects.toThrow(/10 MB|too large/i)
  })

  it('does not pollute Object.prototype', async () => {
    await expect(parseImport(b, '{"__proto__":{"polluted":1},"formatVersion":1,"profiles":[]}')).rejects.toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('applyImport', () => {
  it('adds new profiles and replaces only listed IDs', async () => {
    await b.save(p('x', ['z1']))
    await b.save(p('y', ['z2']))
    const preview = await parseImport(b, envelope([p('x', ['z1', 'z5'], 'rules', { name: 'X2' }), p('y', ['z2'], 'rules', { name: 'Y2' }), p('n', ['z7'])]))
    await applyImport(b, preview, ['x'])
    expect((await b.get('x'))?.name).toBe('X2')
    expect((await b.get('y'))?.name).toBe('Profile y')
    expect((await b.get('n'))?.zoneIds).toEqual(['z7'])
  })

  it('keeps the ID and sets version above the existing one when replacing', async () => {
    await b.save(p('x', ['z1']))
    await b.save(p('x', ['z1']))
    const preview = await parseImport(b, envelope([p('x', ['z1'], 'rules', { version: 1 })]))
    await applyImport(b, preview, ['x'])
    expect((await b.get('x'))?.version).toBe(3)
  })

  it('ignores replaceIds that are not in the preview', async () => {
    await b.save(p('y', ['z2']))
    const preview = await parseImport(b, envelope([p('n', ['z7'])]))
    await applyImport(b, preview, ['y', 'ghost'])
    expect((await b.list('rules')).map((x) => x.id).sort()).toEqual(['n', 'y'])
  })

  it('does not silently replace an ID added concurrently', async () => {
    const preview = await parseImport(b, envelope([p('x', ['z1'])]))
    await b.save(p('x', ['z8']))
    await expect(applyImport(b, preview, [])).rejects.toThrow(/x/)
    expect((await b.get('x'))?.zoneIds).toEqual(['z8'])
  })

  it('refuses to overwrite a profile edited since the preview', async () => {
    const existing = await b.save(p('x', ['z1']))
    const preview = await parseImport(b, envelope([p('x', ['z1'], 'rules', { name: 'Theirs' })]))
    await b.save({ ...existing, name: 'Edited locally' })
    await expect(applyImport(b, preview, ['x'])).rejects.toThrow(/changed/i)
    expect((await b.get('x'))?.name).toBe('Edited locally')
  })

  it('validates a hand-built preview the same way', async () => {
    const preview = { added: [{ ...p('x', ['z1']), token: 'abc' } as Profile<unknown>], replaced: [], zoneClashes: [], parentLinks: {} }
    await expect(applyImport(b, preview, [])).rejects.toThrow()
    expect(await b.list('rules')).toEqual([])
  })
})
