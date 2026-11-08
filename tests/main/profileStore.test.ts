import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileProfileStore } from '../../src/zonekeeper/main/store/profileStore'
import type { ItemKind, Profile } from '../../src/zonekeeper/shared/model'
import { isPlain } from '../../src/zonekeeper/shared/plain'
import { registerSettingsSchema } from '../../src/zonekeeper/shared/schemas'
import { z } from 'zod'

// These tests use 'rules' as a generic item, not the real rules settings.
registerSettingsSchema('rules', z.custom((v) => isPlain(v), 'settings must be a JSON object'))

const p = (id: string, zoneIds: string[] = [], item: ItemKind = 'rules'): Profile<unknown> => ({
  id,
  item,
  name: `Profile ${id}`,
  version: 1,
  zoneIds,
  settings: {},
  updatedAt: '2026-11-06T00:00:00.000Z'
})

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zk-store-'))
  file = join(dir, 'profiles.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('FileProfileStore', () => {
  it('starts empty when the file does not exist', async () => {
    const s = new FileProfileStore(file)
    expect(await s.list('rules')).toEqual([])
    expect(await s.get('nope')).toBeUndefined()
  })

  it('save increments version on each save of an existing profile', async () => {
    const s = new FileProfileStore(file)
    const first = await s.save(p('a', ['z1']))
    expect(first.version).toBe(1)
    const second = await s.save({ ...first, name: 'Renamed' })
    expect(second.version).toBe(2)
    expect((await s.get('a'))?.version).toBe(2)
    expect((await s.get('a'))?.name).toBe('Renamed')
  })

  it('persists across store instances', async () => {
    await new FileProfileStore(file).save(p('a', ['z1']))
    expect((await new FileProfileStore(file).list('rules')).map((x) => x.id)).toEqual(['a'])
  })

  it('lists only profiles of the requested item', async () => {
    const s = new FileProfileStore(file)
    await s.save(p('a', ['z1'], 'rules'))
    await s.save(p('b', ['z1'], 'ssl'))
    expect((await s.list('ssl')).map((x) => x.id)).toEqual(['b'])
  })

  it('allows the same zone in a profile of another item', async () => {
    const s = new FileProfileStore(file)
    await s.save(p('a', ['z1'], 'rules'))
    await expect(s.save(p('b', ['z1'], 'ssl'))).resolves.toBeTruthy()
  })

  it('allows re-saving a profile with its own zones', async () => {
    const s = new FileProfileStore(file)
    const a = await s.save(p('a', ['z1']))
    await expect(s.save(a)).resolves.toBeTruthy()
  })

  it('rejects duplicate zones within one profile', async () => {
    const s = new FileProfileStore(file)
    await expect(s.save(p('a', ['z1', 'z1']))).rejects.toThrow()
  })

  it('rejects a profile with an unknown field', async () => {
    const s = new FileProfileStore(file)
    await expect(s.save({ ...p('a'), token: 'x' } as Profile<unknown>)).rejects.toThrow()
  })

  it('delete removes a profile and frees its zones', async () => {
    const s = new FileProfileStore(file)
    await s.save(p('a', ['z1']))
    await s.delete('a')
    expect(await s.get('a')).toBeUndefined()
    await expect(s.save(p('b', ['z1']))).resolves.toBeTruthy()
  })

  it('a failed write leaves the old file readable and no temp file behind', async () => {
    const s = new FileProfileStore(file)
    await s.save(p('a', ['z1']))
    const before = await readFile(file, 'utf8')
    const failing = new FileProfileStore(file, {
      rename: async () => {
        throw new Error('disk full')
      }
    })
    await expect(failing.save(p('b', ['z2']))).rejects.toThrow(/disk full/)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(dir)).toEqual(['profiles.json'])
    expect((await new FileProfileStore(file).list('rules')).map((x) => x.id)).toEqual(['a'])
  })

  it('serialises concurrent saves without losing any', async () => {
    const s = new FileProfileStore(file)
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.save(p(`p${i}`, [`z${i}`]))))
    expect(await s.list('rules')).toHaveLength(20)
  })

  it('throws on a corrupt file and leaves it untouched', async () => {
    await writeFile(file, '{not json')
    const s = new FileProfileStore(file)
    await expect(s.list('rules')).rejects.toThrow(/corrupt/i)
    await expect(s.save(p('a'))).rejects.toThrow(/corrupt/i)
    expect(await readFile(file, 'utf8')).toBe('{not json')
  })

  it('throws on a file with the wrong shape and leaves it untouched', async () => {
    await writeFile(file, JSON.stringify({ formatVersion: 1, profiles: [{ id: 1 }] }))
    const s = new FileProfileStore(file)
    await expect(s.save(p('a'))).rejects.toThrow(/corrupt/i)
    expect(JSON.parse(await readFile(file, 'utf8')).profiles).toEqual([{ id: 1 }])
  })

  it('refuses a store file from a newer format', async () => {
    await writeFile(file, JSON.stringify({ formatVersion: 99, profiles: [] }))
    await expect(new FileProfileStore(file).list('rules')).rejects.toThrow(/newer/i)
  })
})
