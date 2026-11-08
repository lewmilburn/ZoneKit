import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonFileListSnapshotStore, MAX_SNAPSHOTS_PER_LIST } from '../../src/zonekeeper/main/store/listSnapshots'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zk-snap-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('JsonFileListSnapshotStore', () => {
  it('saves the items and returns a relative reference to them', async () => {
    const items = [{ id: 'f', redirect: { source_url: 'https://b.com/' } }]
    const ref = await new JsonFileListSnapshotStore(dir).save('acc', 'list', items)
    expect(ref).not.toContain(dir)
    const saved = JSON.parse(await readFile(join(dir, ref), 'utf8'))
    expect(saved).toMatchObject({ accountId: 'acc', listId: 'list', items })
    expect(Object.keys(saved).sort()).toEqual(['accountId', 'items', 'listId', 'savedAt'])
  })

  it('keeps only the newest snapshots per list, and leaves other lists alone', async () => {
    const store = new JsonFileListSnapshotStore(dir)
    const other = await store.save('acc', 'other', [])
    const refs: string[] = []
    for (let i = 0; i < MAX_SNAPSHOTS_PER_LIST + 3; i++) refs.push(await store.save('acc', 'list', [i]))
    const left = await readdir(dirname(join(dir, refs[0])))
    expect(left).toHaveLength(MAX_SNAPSHOTS_PER_LIST)
    await expect(readFile(join(dir, refs[0]), 'utf8')).rejects.toThrow()
    await expect(readFile(join(dir, refs.at(-1)!), 'utf8')).resolves.toContain('"listId"')
    await expect(readFile(join(dir, other), 'utf8')).resolves.toContain('"other"')
  })

  it('keeps ordering across store instances', async () => {
    const refs: string[] = []
    for (let i = 0; i < MAX_SNAPSHOTS_PER_LIST + 1; i++) refs.push(await new JsonFileListSnapshotStore(dir).save('acc', 'list', [i]))
    await expect(readFile(join(dir, refs.at(-1)!), 'utf8')).resolves.toContain('"listId"')
    await expect(readFile(join(dir, refs[0]), 'utf8')).rejects.toThrow()
  })

  it('rejects when it cannot save', async () => {
    const blocker = join(dir, 'file')
    await writeFile(blocker, 'x')
    await expect(new JsonFileListSnapshotStore(blocker).save('acc', 'list', [])).rejects.toThrow()
  })

  it('cannot escape its directory through an id', async () => {
    const ref = await new JsonFileListSnapshotStore(dir).save('../..', '../x', [])
    expect(ref).not.toContain('..')
    await expect(readFile(join(dir, ref), 'utf8')).resolves.toBeTruthy()
  })
})
