import { request } from 'node:https'
import type { Resolver } from 'node:dns/promises'
import { z } from 'zod'
import { errorText } from '@app/shared/errorText'
import { RESOLVER_IDS, type EmailCheck, type EmailResult, type IpcResult, type TlsFinding } from '../shared/ipc'
import { cleanName, createResolver, HOST, pool } from './resolver'

const input = z.strictObject({ domain: z.string().trim().min(1).max(253), resolver: z.enum(RESOLVER_IDS) })

/** Common provider selectors, custom ones can't be found from DNS. */
const DKIM_SELECTORS = [
  'default', 'dkim', 'mail', 'email', 'smtp', 'k1', 'k2', 'k3', 's1', 's2', 'selector1', 'selector2', 'google', 'fm1', 'fm2', 'fm3',
  'purelymail1', 'purelymail2', 'purelymail3', 'protonmail', 'protonmail2', 'protonmail3', 'zoho', 'zmail', 'mandrill', 'mxvault',
  'cf2024-1', 'resend', 'sig1', 'mailjet', 'pm', 'everlytickey1', 'everlytickey2', 'krs', 'dk', 'mesmtp', 'sm', 'key1', 'key2'
]
const SPF_LOOKUP_LIMIT = 10

const NO_DATA = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN'])
async function txt(r: Resolver, name: string): Promise<string[]> {
  try {
    return (await r.resolveTxt(name)).map((parts) => parts.join(''))
  } catch (e) {
    if (NO_DATA.has((e as NodeJS.ErrnoException).code ?? '')) return []
    throw e
  }
}

const tags = (record: string): Map<string, string> =>
  new Map(record.split(';').map((p) => p.trim()).filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')).trim().toLowerCase(), p.slice(p.indexOf('=') + 1).trim()] as const))

/** DNS lookups an SPF check costs, which must stay at 10 or under. */
async function spfLookups(r: Resolver, domain: string, seen: Set<string>, depth = 0): Promise<number> {
  if (depth > 10 || seen.has(domain)) return 0
  seen.add(domain)
  const record = (await txt(r, domain).catch(() => [])).find((t) => /^v=spf1(\s|$)/i.test(t))
  if (!record) return 0
  let n = 0
  for (const term of record.split(/\s+/).slice(1)) {
    const t = term.replace(/^[+\-~?]/, '').toLowerCase()
    const target = t.includes(':') ? t.slice(t.indexOf(':') + 1) : t.startsWith('redirect=') ? t.slice('redirect='.length) : ''
    if (t.startsWith('include:') || t.startsWith('redirect=')) n += 1 + (await spfLookups(r, target, seen, depth + 1))
    else if (/^(a|mx|ptr|exists)(:|\/|$)/.test(t)) n += 1
  }
  return n
}

function fetchText(url: string): Promise<string> {
  return new Promise((done, fail) => {
    const req = request(url, { timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return fail(new Error(`HTTP ${res.statusCode}`))
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
        if (body.length > 64_000) req.destroy(new Error('Policy file too large'))
      })
      res.on('end', () => done(body))
    })
    req.on('timeout', () => req.destroy(new Error('Timed out')))
    req.on('error', fail)
    req.end()
  })
}

const check = (name: string, records: string[], findings: TlsFinding[]): EmailCheck => ({ name, records, findings })
const bad = (text: string): TlsFinding => ({ level: 'bad', text })
const warn = (text: string): TlsFinding => ({ level: 'warn', text })
const good = (text: string): TlsFinding => ({ level: 'good', text })

async function mxCheck(r: Resolver, domain: string): Promise<{ check: EmailCheck; hosts: string[] }> {
  const mx = await r.resolveMx(domain).catch((e: NodeJS.ErrnoException) => (NO_DATA.has(e.code ?? '') ? [] : Promise.reject(e)))
  const sorted = [...mx].sort((a, b) => a.priority - b.priority)
  const records = sorted.map((m) => `${m.priority} ${m.exchange || '.'}`)
  if (sorted.length === 1 && (sorted[0]?.exchange ?? '') === '') return { check: check('Mail servers (MX)', records, [good('Null MX, this domain says it accepts no mail')]), hosts: [] }
  if (sorted.length === 0) return { check: check('Mail servers (MX)', records, [warn('No MX records, this domain can’t receive mail')]), hosts: [] }
  return { check: check('Mail servers (MX)', records, [good(`${sorted.length} mail server${sorted.length === 1 ? '' : 's'}`)]), hosts: sorted.map((m) => m.exchange.toLowerCase()) }
}

async function spfCheck(r: Resolver, domain: string): Promise<EmailCheck> {
  const all = (await txt(r, domain)).filter((t) => /^v=spf1(\s|$)/i.test(t))
  if (all.length === 0) return check('SPF', [], [bad('No SPF record, anyone can claim to send as this domain')])
  if (all.length > 1) return check('SPF', all, [bad('More than one SPF record, receivers treat this as an error')])
  const record = all[0] as string
  const f: TlsFinding[] = []
  const terms = record.toLowerCase().split(/\s+/)
  const allTerm = terms.find((t) => /^[+\-~?]?all$/.test(t))
  if (allTerm === undefined && !terms.some((t) => t.startsWith('redirect='))) f.push(warn('No "all" at the end, mail from other servers isn’t marked'))
  else if (allTerm === '+all' || allTerm === 'all') f.push(bad('+all lets every server on the internet send as this domain'))
  else if (allTerm === '?all') f.push(warn('?all is neutral, so spoofed mail isn’t marked'))
  else if (allTerm === '~all') f.push(good('~all marks other servers as suspicious'))
  else if (allTerm === '-all') f.push(good('-all rejects mail from other servers'))
  if (terms.some((t) => /^[+\-~?]?ptr/.test(t))) f.push(warn('ptr is slow and deprecated'))
  const lookups = await spfLookups(r, domain, new Set())
  f.push(lookups > SPF_LOOKUP_LIMIT ? bad(`${lookups} DNS lookups, over the limit of 10, so SPF fails`) : good(`${lookups} of 10 DNS lookups used`))
  return check('SPF', [record], f)
}

async function dmarcCheck(r: Resolver, domain: string): Promise<EmailCheck> {
  const all = (await txt(r, `_dmarc.${domain}`)).filter((t) => /^v=DMARC1(\s|;|$)/i.test(t))
  if (all.length === 0) return check('DMARC', [], [bad('No DMARC record, spoofed mail isn’t blocked')])
  if (all.length > 1) return check('DMARC', all, [bad('More than one DMARC record, receivers ignore them all')])
  const record = all[0] as string
  const t = tags(record)
  const p = t.get('p')?.toLowerCase()
  const f: TlsFinding[] = []
  if (p === 'reject') f.push(good('p=reject blocks mail that fails checks'))
  else if (p === 'quarantine') f.push(good('p=quarantine sends failing mail to spam'))
  else if (p === 'none') f.push(warn('p=none only monitors, spoofed mail is still delivered'))
  else f.push(bad('Missing or unknown policy (p=)'))
  const pct = Number(t.get('pct') ?? '100')
  if (pct < 100) f.push(warn(`pct=${pct}, the policy only applies to some mail`))
  const sp = t.get('sp')?.toLowerCase()
  if (sp === 'none' && p !== 'none') f.push(warn('sp=none leaves subdomains unprotected'))
  f.push(t.has('rua') ? good('Reports are sent to ' + (t.get('rua') ?? '').replace(/mailto:/gi, '')) : warn('No rua=, so you get no reports'))
  return check('DMARC', [record], f)
}

async function dkimCheck(r: Resolver, domain: string): Promise<EmailCheck> {
  const found = (await pool(DKIM_SELECTORS, 8, async (s) => ({ s, records: (await txt(r, `${s}._domainkey.${domain}`).catch(() => [])).filter((t) => /(^|;)\s*(v=DKIM1|k=|p=)/i.test(t)) }))).filter((x) => x.records.length > 0)
  if (found.length === 0) return check('DKIM', [], [warn('No DKIM key on common selectors, it may use a custom one')])
  const f: TlsFinding[] = []
  const records: string[] = []
  for (const { s, records: rs } of found) {
    const key = tags(rs[0] as string).get('p') ?? ''
    records.push(`${s}: ${(rs[0] as string).slice(0, 120)}${(rs[0] as string).length > 120 ? '...' : ''}`)
    // Base64 length gives the RSA key size roughly
    if (key === '') f.push(warn(`${s} has an empty key, so it’s revoked`))
    else if (key.length < 300 && !/k=ed25519/i.test(rs[0] as string)) f.push(warn(`${s} looks like a 1024-bit key, 2048-bit is recommended`))
    else f.push(good(`${s} has a key`))
  }
  return check('DKIM', records, f)
}

async function mtaStsCheck(r: Resolver, domain: string, mxHosts: string[]): Promise<EmailCheck> {
  const records = (await txt(r, `_mta-sts.${domain}`)).filter((t) => /^v=STSv1/i.test(t))
  if (records.length === 0) return check('MTA-STS', [], [warn('No MTA-STS, mail to this domain can be downgraded to unencrypted')])
  let policy: string
  try {
    policy = await fetchText(`https://mta-sts.${domain}/.well-known/mta-sts.txt`)
  } catch (e) {
    return check('MTA-STS', records, [bad(`The policy file couldn’t be fetched: ${errorText(e)}`)])
  }
  const lines = new Map<string, string[]>()
  for (const line of policy.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) lines.set(line.slice(0, i).trim().toLowerCase(), [...(lines.get(line.slice(0, i).trim().toLowerCase()) ?? []), line.slice(i + 1).trim()])
  }
  const mode = lines.get('mode')?.[0]?.toLowerCase()
  const f: TlsFinding[] = []
  if (mode === 'enforce') f.push(good('mode: enforce, senders must use TLS'))
  else if (mode === 'testing') f.push(warn('mode: testing, failures are only reported'))
  else f.push(warn(`mode: ${mode ?? 'missing'}, the policy has no effect`))
  const patterns = lines.get('mx') ?? []
  const covered = (host: string): boolean => patterns.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) && host.split('.').length === p.split('.').length : host === p.toLowerCase()))
  const missing = mxHosts.filter((h) => !covered(h))
  if (missing.length > 0) f.push(bad(`The policy doesn’t list ${missing.join(', ')}, so mail to it fails under enforce`))
  return check('MTA-STS', [...records, ...policy.trim().split(/\r?\n/)], f)
}

async function tlsRptCheck(r: Resolver, domain: string): Promise<EmailCheck> {
  const records = (await txt(r, `_smtp._tls.${domain}`)).filter((t) => /^v=TLSRPTv1/i.test(t))
  return check('TLS reporting (TLS-RPT)', records, records.length > 0 ? [good('TLS failure reports are on')] : [warn('No TLS-RPT, you won’t hear about TLS failures')])
}

async function bimiCheck(r: Resolver, domain: string): Promise<EmailCheck> {
  const records = (await txt(r, `default._bimi.${domain}`)).filter((t) => /^v=BIMI1/i.test(t))
  return check('BIMI', records, records.length > 0 ? [good('A brand logo is published')] : [])
}

export async function testEmail(raw: unknown): Promise<IpcResult<EmailResult>> {
  const parsed = input.safeParse(raw)
  const domain = parsed.success ? cleanName(parsed.data.domain) : ''
  if (!parsed.success || !HOST.test(domain)) return { ok: false, error: 'Enter a domain, such as example.com.' }
  const start = Date.now()
  try {
    const r = createResolver(parsed.data.resolver)
    // Errors become findings, so one failing check doesn't hide the rest
    const safe = (name: string, work: Promise<EmailCheck>): Promise<EmailCheck> => work.catch((e: unknown) => check(name, [], [warn(`Couldn’t check: ${errorText(e)}`)]))
    const mx = await mxCheck(r, domain)
    const checks = await Promise.all([
      safe('SPF', spfCheck(r, domain)),
      safe('DMARC', dmarcCheck(r, domain)),
      safe('DKIM', dkimCheck(r, domain)),
      safe('MTA-STS', mtaStsCheck(r, domain, mx.hosts)),
      safe('TLS reporting (TLS-RPT)', tlsRptCheck(r, domain)),
      safe('BIMI', bimiCheck(r, domain))
    ])
    return { ok: true, value: { domain, checks: [mx.check, ...checks], ms: Date.now() - start } }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}
