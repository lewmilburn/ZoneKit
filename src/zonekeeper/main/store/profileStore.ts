import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import type { ItemKind, Profile } from '../../shared/model'
import { FORMAT_VERSION, describeIssues, importEnvelopeSchema, parseProfile } from '../../shared/schemas'

export interface ProfileStore {
  list(item: ItemKind): Promise<Profile<unknown>[]>
  get(id: string): Promise<Profile<unknown> | undefined>
  /** Returns it with the new version. */
  save(profile: Profile<unknown>): Promise<Profile<unknown>>
  delete(id: string): Promise<void>
}

export interface StoreIo {
  rename?: (from: string, to: string) => Promise<void>
  /** After each write, for ZoneKit Cloud. */
  onWrite?: () => void
}

export class StoreCorruptError extends Error {}

export class FileProfileStore implements ProfileStore {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly rename: (from: string, to: string) => Promise<void>
  private readonly onWrite: () => void

  constructor(
    private readonly filePath: string,
    io: StoreIo = {}
  ) {
    this.rename = io.rename ?? rename
    this.onWrite = io.onWrite ?? (() => undefined)
  }

  list(item: ItemKind): Promise<Profile<unknown>[]> {
    return this.locked(async () => (await this.load()).filter((p) => p.item === item))
  }

  get(id: string): Promise<Profile<unknown> | undefined> {
    return this.locked(async () => (await this.load()).find((p) => p.id === id))
  }

  async save(profile: Profile<unknown>): Promise<Profile<unknown>> {
    return (await this.saveAll([profile]))[0]
  }

  /** All or nothing. */
  saveAll(
    profiles: Profile<unknown>[],
    precondition?: (current: Profile<unknown>[]) => void
  ): Promise<Profile<unknown>[]> {
    return this.locked(async () => {
      const next = await this.load()
      precondition?.(next)
      const stored: Profile<unknown>[] = []
      const seen = new Set<string>()
      for (const input of profiles) {
        const profile = parseProfile(input)
        if (seen.has(profile.id)) throw new Error(`Profile ID "${profile.id}" appears twice`)
        seen.add(profile.id)
        const i = next.findIndex((p) => p.id === profile.id)
        if (i >= 0 && next[i].item !== profile.item) {
          throw new Error(`Profile "${profile.id}" belongs to item "${next[i].item}" and cannot change item`)
        }
        const out = { ...profile, version: i >= 0 ? next[i].version + 1 : profile.version }
        if (i >= 0) next[i] = out
        else next.push(out)
        stored.push(out)
      }
      await this.write(next)
      return stored
    })
  }

  delete(id: string): Promise<void> {
    return this.locked(async () => {
      const all = await this.load()
      const next = all.filter((p) => p.id !== id)
      if (next.length !== all.length) await this.write(next)
    })
  }

  /** One operation at a time. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async load(): Promise<Profile<unknown>[]> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    const corrupt = (why: string): StoreCorruptError =>
      new StoreCorruptError(`The profile store file is corrupt (${why}): ${this.filePath}`)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw corrupt('not valid JSON')
    }
    const env = importEnvelopeSchema.safeParse(json)
    if (!env.success) throw corrupt(describeIssues(env.error))
    if (env.data.formatVersion > FORMAT_VERSION) {
      throw new StoreCorruptError(
        `The profile store file was written by a newer version of Zonekeeper and was left untouched: ${this.filePath}`
      )
    }
    try {
      return env.data.profiles.map(parseProfile)
    } catch (e) {
      throw corrupt((e as Error).message)
    }
  }

  private async write(profiles: Profile<unknown>[]): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const tmp = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const fh = await open(tmp, 'wx', 0o600)
      try {
        await fh.writeFile(JSON.stringify({ formatVersion: FORMAT_VERSION, profiles }, null, 2), 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await this.rename(tmp, this.filePath)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw e
    }
    this.onWrite()
  }
}

