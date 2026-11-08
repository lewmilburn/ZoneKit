import { request } from 'node:https'
import { connect, type DetailedPeerCertificate, type TLSSocket } from 'node:tls'
import { z } from 'zod'
import { errorText } from '@app/shared/errorText'
import { TLS_VERSIONS, type IpcResult, type TlsFinding, type TlsProtocol, type TlsResult, type TlsVersion } from '../shared/ipc'
import { cleanName, HOST } from './resolver'

const input = z.strictObject({ host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65535) })
const TIMEOUT_MS = 6000

/** Ciphers no server should still offer. */
const WEAK_CIPHER = /RC4|3DES|DES-CBC|NULL|EXPORT|MD5|anon/i
/** Errors from our own TLS library, not the server. */
const LOCAL_ERRORS = /NO_PROTOCOLS_AVAILABLE|UNSUPPORTED_PROTOCOL|no protocols available|INVALID_COMMAND|NO_CIPHER_MATCH/i

type Outcome = { socket: TLSSocket } | { error: Error; local?: true }

function handshake(host: string, port: number, version?: TlsVersion): Promise<Outcome> {
  return new Promise((done) => {
    let socket: TLSSocket
    try {
      socket = connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
        ...(version ? { minVersion: version, maxVersion: version } : {}),
        // Old versions need old ciphers, BoringSSL has no @SECLEVEL
        ...(version && version !== 'TLSv1.3' ? { ciphers: 'ALL' } : {})
      })
    } catch (e) {
      // Thrown before connecting, so it's our side
      done({ error: e instanceof Error ? e : new Error(String(e)), local: true })
      return
    }
    socket.once('secureConnect', () => done({ socket }))
    socket.once('timeout', () => {
      socket.destroy()
      done({ error: new Error('Timed out') })
    })
    socket.once('error', (error) => done({ error }))
  })
}

async function probe(host: string, port: number, version: TlsVersion): Promise<TlsProtocol> {
  const r = await handshake(host, port, version)
  if ('error' in r) {
    const local = r.local || LOCAL_ERRORS.test(`${(r.error as { code?: string }).code ?? ''} ${r.error.message}`)
    return { version, supported: local ? null : false, cipher: null }
  }
  const cipher = r.socket.getCipher().name
  r.socket.destroy()
  return { version, supported: true, cipher }
}

function hstsHeader(host: string, port: number): Promise<string | null> {
  return new Promise((done) => {
    const req = request({ host, port, method: 'HEAD', path: '/', servername: host, rejectUnauthorized: false, timeout: TIMEOUT_MS }, (res) => {
      const h = res.headers['strict-transport-security']
      res.resume()
      done(typeof h === 'string' ? h : null)
    })
    req.once('timeout', () => req.destroy())
    req.once('error', () => done(null))
    req.end()
  })
}

const name = (x: Record<string, unknown> | undefined): string => String(x?.CN ?? x?.O ?? '')

export async function testTls(raw: unknown): Promise<IpcResult<TlsResult>> {
  const i = input.safeParse(raw)
  if (!i.success) return { ok: false, error: 'Enter a host and a port from 1 to 65535.' }
  const host = cleanName(i.data.host)
  const { port } = i.data
  if (!HOST.test(host)) return { ok: false, error: `${host} isn't a valid host name.` }

  const main = await handshake(host, port)
  if ('error' in main) return { ok: false, error: `Couldn't connect to ${host}:${port} over TLS, ${errorText(main.error)}` }
  const cert = main.socket.getPeerCertificate(true) as DetailedPeerCertificate
  const trusted = main.socket.authorized
  const trustError = main.socket.authorizationError ? String(main.socket.authorizationError) : null
  main.socket.destroy()

  const [protocols, hsts] = await Promise.all([Promise.all(TLS_VERSIONS.map((v) => probe(host, port, v))), port === 443 ? hstsHeader(host, port) : Promise.resolve(null)])

  const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000)
  const names = (cert.subjectaltname ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4))
  const keyBits = typeof cert.bits === 'number' ? cert.bits : null
  const isEc = Boolean((cert as { asn1Curve?: string }).asn1Curve)

  const findings: TlsFinding[] = []
  const on = (v: TlsVersion): boolean | null => protocols.find((p) => p.version === v)?.supported ?? null
  if (on('TLSv1') || on('TLSv1.1')) findings.push({ level: 'bad', text: 'TLS 1.0 or 1.1 is enabled, these are deprecated and insecure' })
  if (on('TLSv1.3') === false) findings.push({ level: 'warn', text: 'TLS 1.3 is not supported' })
  if (on('TLSv1.2') === false && on('TLSv1.3') === false) findings.push({ level: 'bad', text: 'Neither TLS 1.2 nor 1.3 is supported' })
  if (protocols.some((p) => p.supported === null)) findings.push({ level: 'warn', text: "Some old versions couldn't be tested from this computer" })
  for (const p of protocols) if (p.cipher && WEAK_CIPHER.test(p.cipher)) findings.push({ level: 'bad', text: `Weak cipher ${p.cipher} over ${p.version}` })
  if (!trusted) findings.push({ level: 'bad', text: `The certificate isn't trusted, ${trustError ?? 'unknown reason'}` })
  if (daysLeft < 0) findings.push({ level: 'bad', text: 'The certificate has expired' })
  else if (daysLeft < 14) findings.push({ level: 'warn', text: `The certificate expires in ${daysLeft} days` })
  if (keyBits !== null && !isEc && keyBits < 2048) findings.push({ level: 'bad', text: `The RSA key is only ${keyBits} bits` })
  if (port === 443 && !hsts) findings.push({ level: 'warn', text: 'No HSTS header, so browsers may still try plain HTTP' })
  if (findings.every((f) => f.level !== 'bad')) findings.unshift({ level: 'good', text: 'No insecure TLS found' })

  return {
    ok: true,
    value: {
      host,
      port,
      protocols,
      certificate: {
        subject: name(cert.subject as unknown as Record<string, unknown>),
        issuer: name(cert.issuer as unknown as Record<string, unknown>),
        names,
        validFrom: new Date(cert.valid_from).toISOString(),
        validTo: new Date(cert.valid_to).toISOString(),
        daysLeft,
        keyBits,
        trusted,
        trustError
      },
      hsts,
      findings
    }
  }
}
