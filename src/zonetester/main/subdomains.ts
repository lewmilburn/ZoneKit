import type { Resolver } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:tls'
import { z } from 'zod'
import { RESOLVER_IDS, SUBDOMAIN_SOURCES, type IpcResult, type Subdomain, type SubdomainResult, type SubdomainSource } from '../shared/ipc'
import { cleanName, createResolver, HOST, pool } from './resolver'
import { SRV_NAMES, variations, WORDLIST } from './wordlist'

const input = z.strictObject({
  domain: z.string().trim().min(1).max(253),
  sources: z.array(z.enum(SUBDOMAIN_SOURCES)).min(1),
  resolver: z.enum(RESOLVER_IDS)
})

/** Caps work on very large zones. */
const MAX_NAMES = 5000
const GUESSES = new Set<SubdomainSource>(['wordlist', 'variations'])
const MAX_CERT_HOSTS = 60

const under = (domain: string) => (name: string): boolean => name.endsWith(`.${domain}`) && HOST.test(name)
const clean = (s: string): string => s.trim().toLowerCase().replace(/\.$/, '').replace(/^\*\./, '')

/** Names in the domain's own MX, NS, SRV and SPF records. */
async function fromRecords(r: Resolver, domain: string): Promise<string[]> {
  const ok = under(domain)
  const [mx, ns, txt, srv] = await Promise.all([
    r.resolveMx(domain).then((x) => x.map((m) => m.exchange)).catch(() => []),
    r.resolveNs(domain).catch(() => [] as string[]),
    r.resolveTxt(domain).then((x) => x.map((p) => p.join(''))).catch(() => [] as string[]),
    pool(SRV_NAMES, 10, (s) => r.resolveSrv(`${s}.${domain}`).then((x) => x.map((v) => v.name)).catch(() => [] as string[]))
  ])
  const spf = txt.filter((t) => /^v=spf1/i.test(t)).flatMap((t) => [...t.matchAll(/(?:include|a|mx|exists|redirect)[:=]([^\s]+)/gi)].map((m) => m[1] ?? ''))
  return [...mx, ...ns, ...spf, ...srv.flat()].map(clean).filter(ok)
}

/** Other names on the host's HTTPS certificate. */
function certificateNames(host: string): Promise<string[]> {
  return new Promise((done) => {
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 5000 })
    const finish = (names: string[]): void => {
      socket.destroy()
      done(names)
    }
    socket.once('secureConnect', () => {
      const san = socket.getPeerCertificate().subjectaltname ?? ''
      finish(san.split(',').map((s) => s.trim()).filter((s) => s.startsWith('DNS:')).map((s) => clean(s.slice(4))))
    })
    socket.once('timeout', () => finish([]))
    socket.once('error', () => finish([]))
  })
}

async function resolve(r: Resolver, name: string): Promise<{ addresses: string[]; cname: string | null }> {
  const [v4, v6, cname] = await Promise.all([
    r.resolve4(name).catch(() => [] as string[]),
    r.resolve6(name).catch(() => [] as string[]),
    r.resolveCname(name).then((c) => c[0] ?? null).catch(() => null)
  ])
  return { addresses: [...v4, ...v6], cname }
}

export async function findSubdomains(raw: unknown): Promise<IpcResult<SubdomainResult>> {
  const i = input.safeParse(raw)
  if (!i.success) return { ok: false, error: 'Choose at least one source.' }
  const domain = cleanName(i.data.domain)
  if (!HOST.test(domain) || !domain.includes('.')) return { ok: false, error: `${domain} isn't a valid domain name.` }
  const started = Date.now()
  const r = createResolver(i.data.resolver)
  const found = new Map<string, Set<SubdomainSource>>()
  const add = (name: string, source: SubdomainSource): void => {
    if (name !== domain) found.set(name, (found.get(name) ?? new Set()).add(source))
  }
  const has = (s: SubdomainSource): boolean => i.data.sources.includes(s)

  if (has('wordlist')) for (const w of WORDLIST) add(`${w}.${domain}`, 'wordlist')
  if (has('records')) for (const n of await fromRecords(r, domain)) add(n, 'records')

  // A made-up name that resolves means wildcard DNS
  const probe = await resolve(r, `zk-${randomBytes(6).toString('hex')}.${domain}`)
  const wildcardAddresses = new Set(probe.addresses)
  const wildcard = wildcardAddresses.size > 0 || probe.cname !== null
  const isWildcardHit = (x: { addresses: string[]; cname: string | null }): boolean =>
    wildcard && x.cname === probe.cname && x.addresses.every((a) => wildcardAddresses.has(a))

  const live = new Map<string, { addresses: string[]; cname: string | null }>()
  const resolveAll = async (names: string[]): Promise<void> => {
    const todo = names.filter((n) => !live.has(n)).slice(0, MAX_NAMES)
    for (const res of await pool(todo, 25, async (n) => ({ n, ...(await resolve(r, n)) }))) {
      if (res.addresses.length > 0 || res.cname !== null) live.set(res.n, { addresses: res.addresses, cname: res.cname })
    }
  }
  await resolveAll([...found.keys()])

  const real = (): string[] => [...live.keys()].filter((n) => !isWildcardHit(live.get(n)!))

  if (has('certificates')) {
    const hosts = [domain, ...real()].slice(0, MAX_CERT_HOSTS)
    const names = (await pool(hosts, 10, certificateNames)).flat().filter(under(domain))
    for (const n of names) add(n, 'certificates')
    await resolveAll(names)
  }

  // Two rounds, so variations of variations are tried too
  if (has('variations')) {
    const tried = new Set<string>()
    for (let round = 0; round < 2; round++) {
      const seeds = real().filter((n) => !tried.has(n))
      seeds.forEach((n) => tried.add(n))
      const names = seeds
        .flatMap((n) => {
          const [label, ...rest] = n.split('.')
          return variations(label ?? '').map((v) => [v, ...rest].join('.'))
        })
        .filter((n) => under(domain)(n) && !found.has(n))
      for (const n of names) add(n, 'variations')
      await resolveAll(names)
    }
  }

  const subdomains: Subdomain[] = []
  const stale: string[] = []
  for (const [name, sources] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const res = live.get(name)
    const from = [...sources]
    const guessed = from.every((s) => GUESSES.has(s))
    if (!res) {
      // Misses of guesses aren't stale names
      if (!guessed) stale.push(name)
      continue
    }
    const hit = isWildcardHit(res)
    // A wildcard answer for a guessed name proves nothing
    if (hit && guessed) continue
    subdomains.push({ name, addresses: res.addresses, cname: res.cname, sources: from, wildcard: hit })
  }
  return { ok: true, value: { domain, subdomains, stale, wildcard, ms: Date.now() - started } }
}
