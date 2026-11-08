import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { z } from 'zod'
import { errorText } from '@app/shared/errorText'
import type { IpcResult, TestsslFinding, TestsslResult, TestsslStatus } from '../shared/ipc'
import { cleanName, HOST } from './resolver'
import { downloadSizeMb, ensureTestssl, isInstalled, type TestsslInstall } from './testsslInstall'

const input = z.strictObject({ host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65535) })
const TIMEOUT_MS = 15 * 60_000

/** Streams each output line to `onLine`, with no stdin so a prompt can't hang it. */
function run(t: TestsslInstall, args: string[], onLine: (line: string) => void): Promise<void> {
  const env = { ...process.env, PATH: [...t.path, process.env['PATH'] ?? ''].filter(Boolean).join(delimiter) }
  return new Promise((done, fail) => {
    const child = spawn(t.bash, [t.script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error('testssl.sh took longer than 15 minutes'))
    }, TIMEOUT_MS)
    let partial = ''
    const feed = (chunk: Buffer): void => {
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l.replace(/\x1b\[[0-9;]*m/g, ''))
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.once('error', (e) => {
      clearTimeout(timer)
      fail(e)
    })
    // Exits non-zero when it finds problems, the JSON file is what matters
    child.once('close', () => {
      clearTimeout(timer)
      if (partial.trim()) onLine(partial)
      done()
    })
  })
}

export async function testsslStatus(): Promise<IpcResult<TestsslStatus>> {
  return { ok: true, value: { installed: await isInstalled(), downloadMb: downloadSizeMb() } }
}

export async function runTestssl(raw: unknown, onLine: (line: string) => void = () => undefined): Promise<IpcResult<TestsslResult>> {
  const i = input.safeParse(raw)
  if (!i.success) return { ok: false, error: 'Enter a host and a port from 1 to 65535.' }
  const host = cleanName(i.data.host)
  if (!HOST.test(host)) return { ok: false, error: `${host} isn't a valid host name.` }
  let install: TestsslInstall
  try {
    if (!(await isInstalled())) onLine('Downloading testssl.sh...')
    install = await ensureTestssl()
  } catch (e) {
    return { ok: false, error: `Couldn't set up testssl.sh, ${errorText(e)}` }
  }
  const json = join(tmpdir(), `zonetester-${randomBytes(6).toString('hex')}.json`)
  const started = Date.now()
  try {
    await run(install, ['--quiet', '--warnings', 'off', '--color', '0', '--jsonfile', json, `${host}:${i.data.port}`], onLine)
    const rows = JSON.parse(await readFile(json, 'utf8')) as Array<Record<string, string>>
    const findings: TestsslFinding[] = rows.map((r) => ({
      id: r['id'] ?? '',
      severity: (r['severity'] ?? 'INFO').toUpperCase(),
      finding: r['finding'] ?? '',
      cve: r['cve'] ?? null,
      // "host/1.2.3.4"
      ip: (r['ip'] ?? '').split('/').pop() ?? ''
    }))
    return { ok: true, value: { host, port: i.data.port, findings, ms: Date.now() - started } }
  } catch (e) {
    return { ok: false, error: `testssl.sh failed, ${errorText(e)}` }
  } finally {
    await rm(json, { force: true })
  }
}
