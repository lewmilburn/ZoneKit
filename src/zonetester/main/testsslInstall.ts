import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'

/** Pinned downloads, each checked against its SHA-256 before use. */
const TESTSSL = {
  version: '3.2.5',
  url: 'https://github.com/testssl/testssl.sh/archive/refs/tags/v3.2.5.tar.gz',
  sha256: '23bb53d50ae093b89631e9fff547c087f632bf35f7a3d7dc78dd4ffff56cd779'
}
const PORTABLE_GIT = {
  version: '2.56.0.4',
  x64: {
    url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe',
    sha256: 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1'
  },
  arm64: {
    url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-arm64.7z.exe',
    sha256: '044110f9d951858452ddb5e4b5415ea0f2b5b2598e794d6fec77fe28b9aa8cc0'
  }
}

const dataDir = (): string => join(app.getPath('appData'), 'ZoneTester')
const testsslDir = (): string => join(dataDir(), `testssl.sh-${TESTSSL.version}`)
const gitDir = (): string => join(dataDir(), `PortableGit-${PORTABLE_GIT.version}`)
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

export interface TestsslInstall {
  script: string
  /** The bash to run it with. */
  bash: string
  /** Extra PATH entries testssl.sh needs. */
  path: string[]
}

function exec(file: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => execFile(file, args, { timeout: 10 * 60_000 }, (err) => (err ? fail(err) : done())))
}

/** Streams to disk and checks the hash, deleting the file on a mismatch. */
async function download(url: string, sha256: string, to: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed, HTTP ${res.status} from ${new URL(url).host}`)
  const hash = createHash('sha256')
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(body, createWriteStream(to))
  if (hash.digest('hex') !== sha256) {
    await rm(to, { force: true })
    throw new Error(`The download from ${new URL(url).host} didn't match its checksum, so it wasn't used`)
  }
}

async function installTestssl(): Promise<void> {
  const tarball = join(dataDir(), `testssl-${TESTSSL.version}.tar.gz`)
  await download(TESTSSL.url, TESTSSL.sha256, tarball)
  try {
    await exec('tar', ['-xzf', tarball, '-C', dataDir()])
  } finally {
    await rm(tarball, { force: true })
  }
}

async function installGit(): Promise<void> {
  const pick = process.arch === 'arm64' ? PORTABLE_GIT.arm64 : PORTABLE_GIT.x64
  const sfx = join(dataDir(), `PortableGit-${PORTABLE_GIT.version}.7z.exe`)
  await download(pick.url, pick.sha256, sfx)
  try {
    // A 7-Zip self-extractor: -o picks the folder, -y skips prompts
    await exec(sfx, [`-o${gitDir()}`, '-y'])
  } finally {
    await rm(sfx, { force: true })
  }
}

export async function isInstalled(): Promise<boolean> {
  const script = await exists(join(testsslDir(), 'testssl.sh'))
  return process.platform === 'win32' ? script && (await exists(join(gitDir(), 'bin', 'bash.exe'))) : script
}

/** Approximate first-time download, for the UI. */
export const downloadSizeMb = (): number => (process.platform === 'win32' ? 62 : 2)

let installing: Promise<TestsslInstall> | null = null

/** Downloads anything missing, once, then returns how to run testssl.sh. */
export function ensureTestssl(): Promise<TestsslInstall> {
  installing ??= (async () => {
    await mkdir(dataDir(), { recursive: true })
    if (!(await exists(join(testsslDir(), 'testssl.sh')))) await installTestssl()
    if (process.platform === 'win32') {
      if (!(await exists(join(gitDir(), 'bin', 'bash.exe')))) await installGit()
      return { script: join(testsslDir(), 'testssl.sh'), bash: join(gitDir(), 'bin', 'bash.exe'), path: [join(gitDir(), 'usr', 'bin'), join(gitDir(), 'mingw64', 'bin')] }
    }
    return { script: join(testsslDir(), 'testssl.sh'), bash: '/bin/bash', path: [] }
  })().catch((e: unknown) => {
    installing = null
    throw e
  })
  return installing
}
