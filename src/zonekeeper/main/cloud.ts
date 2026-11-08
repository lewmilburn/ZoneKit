import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CfApiError, type CfClient } from './cloudflare/client'
import { UserError } from './errors'
import { errorText } from '../shared/errorText'
import { importEnvelopeSchema, parseProfile } from '../shared/schemas'
import type { CloudAccount, CloudActivity, CloudStatus } from '../shared/ipc'

/** Everything ZoneKeeper keeps, stored as one KV value so a save is one write. */
export const CLOUD_FILES = ['profiles.json', 'parent-links.json', 'sync-state.json', 'last-synced.json'] as const
const NAMESPACE = 'ZoneKit'
const KEY = 'zonekeeper'
const UPLOAD_DELAY_MS = 2000
const CHECK_EVERY_MS = 60_000

interface Config {
  enabled: boolean
  accountId: string
  accountName: string
  namespaceId: string
  /** Revision this computer last uploaded or downloaded. */
  revision: number
  savedAt: string | null
  bytes: number | null
  checkedAt: string | null
  activity: CloudActivity[]
}

const MAX_ACTIVITY = 50
const kb = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)

interface Doc {
  revision: number
  savedAt: string
  files: Record<string, unknown>
}

const OFF: Config = { enabled: false, accountId: '', accountName: '', namespaceId: '', revision: 0, savedAt: null, bytes: null, checkedAt: null, activity: [] }

const describe = (e: unknown): string =>
  e instanceof CfApiError && e.status === 403 ? 'Your token needs Account, Workers KV Storage, Edit.' : errorText(e)

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}

export interface Cloud {
  status(): CloudStatus
  accounts(): Promise<CloudAccount[]>
  /** `use` picks which copy wins when both exist. */
  enable(accountId: string, use?: 'cloud' | 'local'): Promise<CloudStatus>
  disable(): Promise<CloudStatus>
  /** Settles a clash between this computer and the cloud. */
  resolve(use: 'cloud' | 'local'): Promise<CloudStatus>
  /** Call after any local data file changes. */
  changed(): void
  /** Downloads a newer cloud copy, if there is one. */
  check(): Promise<void>
}

export function createCloud(deps: { dir: string; client: CfClient; onDownloaded: () => void; onStatus: (s: CloudStatus) => void }): Cloud {
  const configPath = join(deps.dir, 'cloud.json')
  let config: Config = OFF
  let state: CloudStatus['state'] = 'idle'
  let error: string | null = null
  let clash = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<unknown> = Promise.resolve()
  // Our own downloads write files, which shouldn't upload them again
  let downloading = false

  const loaded = readFile(configPath, 'utf8')
    .then((t) => {
      config = { ...OFF, ...(JSON.parse(t) as Partial<Config>) }
    })
    .catch(() => undefined)

  const status = (): CloudStatus => ({
    enabled: config.enabled,
    accountName: config.accountName,
    savedAt: config.savedAt,
    state,
    error,
    clash,
    namespace: NAMESPACE,
    key: KEY,
    revision: config.revision,
    bytes: config.bytes,
    checkedAt: config.checkedAt,
    activity: config.activity
  })
  const report = (): void => deps.onStatus(status())
  const saveConfig = (): Promise<void> => mkdir(deps.dir, { recursive: true }).then(() => atomicWrite(configPath, JSON.stringify(config, null, 2)))
  const log = (level: CloudActivity['level'], text: string): void => {
    config = { ...config, activity: [{ at: new Date().toISOString(), level, text }, ...config.activity].slice(0, MAX_ACTIVITY) }
  }
  const valuePath = (c: Config = config): string => `/accounts/${c.accountId}/storage/kv/namespaces/${c.namespaceId}/values/${KEY}`

  // One cloud operation at a time
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  async function readRemote(c: Config = config): Promise<Doc | null> {
    const text = await deps.client.getText(valuePath(c))
    if (text === null) return null
    const doc = JSON.parse(text) as Doc
    if (typeof doc?.revision !== 'number' || typeof doc.files !== 'object') throw new UserError('The ZoneKit Cloud copy is damaged, so nothing was downloaded.')
    return doc
  }

  async function localDoc(revision: number): Promise<Doc> {
    const files: Record<string, unknown> = {}
    for (const name of CLOUD_FILES) {
      const text = await readFile(join(deps.dir, name), 'utf8').catch(() => null)
      if (text !== null) files[name] = JSON.parse(text)
    }
    return { revision, savedAt: new Date().toISOString(), files }
  }

  async function upload(force = false): Promise<void> {
    const remote = await readRemote()
    if (!force && remote && remote.revision !== config.revision) {
      clash = true
      log('bad', `Another computer saved revision ${remote.revision}, choose which copy to keep`)
      await saveConfig()
      throw new UserError('ZoneKit Cloud was changed on another computer since this one last saved.')
    }
    const doc = await localDoc((remote?.revision ?? config.revision) + 1)
    const text = JSON.stringify(doc)
    await deps.client.putText(valuePath(), text)
    const bytes = Buffer.byteLength(text)
    config = { ...config, revision: doc.revision, savedAt: doc.savedAt, bytes }
    log('good', `Uploaded revision ${doc.revision}, ${kb(bytes)}${force && remote ? ', replacing the cloud copy' : ''}`)
    clash = false
    await saveConfig()
  }

  async function download(doc: Doc): Promise<void> {
    // Checked before anything is written
    const profiles = doc.files['profiles.json']
    if (profiles !== undefined) {
      const env = importEnvelopeSchema.parse(profiles)
      env.profiles.forEach((p) => parseProfile(p))
    }
    downloading = true
    try {
      await mkdir(deps.dir, { recursive: true })
      for (const name of CLOUD_FILES) {
        const value = doc.files[name]
        if (value === undefined) await unlink(join(deps.dir, name)).catch(() => undefined)
        else await atomicWrite(join(deps.dir, name), JSON.stringify(value, null, 2))
      }
    } finally {
      downloading = false
    }
    const bytes = Buffer.byteLength(JSON.stringify(doc))
    config = { ...config, revision: doc.revision, savedAt: doc.savedAt, bytes }
    log('info', `Downloaded revision ${doc.revision}, ${kb(bytes)}, saved ${new Date(doc.savedAt).toLocaleString()}`)
    clash = false
    await saveConfig()
    deps.onDownloaded()
  }

  const run = async (work: () => Promise<void>): Promise<void> => {
    state = 'saving'
    error = null
    report()
    try {
      await work()
      state = 'idle'
    } catch (e) {
      state = 'error'
      error = describe(e)
      // Clashes are logged where they're found
      if (!clash) {
        log('bad', error)
        await saveConfig().catch(() => undefined)
      }
    }
    report()
  }

  setInterval(() => void cloud.check(), CHECK_EVERY_MS)

  const cloud: Cloud = {
    status,

    async accounts() {
      const list = await deps.client.get<Array<{ id: string; name: string }>>('/accounts?per_page=50')
      return list.map((a) => ({ id: a.id, name: a.name }))
    },

    enable: (accountId, use) =>
      serial(async () => {
        await loaded
        const account = (await cloud.accounts()).find((a) => a.id === accountId)
        if (!account) throw new UserError('That account was not found for this token.')
        let namespaceId: string
        try {
          const list = await deps.client.get<Array<{ id: string; title: string }>>(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`)
          namespaceId = list.find((n) => n.title === NAMESPACE)?.id ?? (await deps.client.send<{ id: string }>('POST', `/accounts/${accountId}/storage/kv/namespaces`, { title: NAMESPACE })).id
        } catch (e) {
          throw new UserError(describe(e))
        }
        const next: Config = { ...OFF, activity: config.activity, enabled: true, accountId, accountName: account.name, namespaceId }
        const remote = await readRemote(next).catch((e: unknown) => Promise.reject(new UserError(describe(e))))
        if (remote && !use) {
          // Both copies exist, the user picks
          clash = true
          return { ...status(), clash: true, enabled: false, accountName: account.name, savedAt: remote.savedAt }
        }
        config = next
        log('info', `Turned on for ${account.name}`)
        if (remote && use === 'cloud') await download(remote)
        else {
          config = { ...config, revision: remote?.revision ?? 0 }
          await upload(true)
        }
        await saveConfig()
        state = 'idle'
        error = null
        report()
        return status()
      }),

    disable: () =>
      serial(async () => {
        await loaded
        config = { ...config, enabled: false }
        log('info', 'Turned off, the cloud copy was kept')
        clash = false
        state = 'idle'
        error = null
        await saveConfig()
        report()
        return status()
      }),

    resolve: (use) =>
      serial(async () => {
        await run(async () => {
          if (use === 'local') await upload(true)
          else {
            const remote = await readRemote()
            if (remote) await download(remote)
          }
        })
        return status()
      }),

    changed() {
      if (downloading || !config.enabled) return
      if (timer) clearTimeout(timer)
      // Batched, as KV allows one write a second per key
      timer = setTimeout(() => {
        timer = null
        void serial(() => run(() => upload()))
      }, UPLOAD_DELAY_MS)
    },

    check: () =>
      serial(async () => {
        await loaded
        // Waiting uploads go first, so nothing local is lost
        if (!config.enabled || timer || clash) return
        try {
          const remote = await readRemote()
          config = { ...config, checkedAt: new Date().toISOString() }
          if (remote && remote.revision > config.revision) await run(() => download(remote))
          else {
            if (state === 'error' && !clash) {
              state = 'idle'
              error = null
            }
            report()
          }
        } catch (e) {
          const message = describe(e)
          // Logged once, not every minute it keeps failing
          if (message !== error) {
            log('bad', message)
            await saveConfig().catch(() => undefined)
          }
          state = 'error'
          error = message
          report()
        }
      })
  }
  return cloud
}
