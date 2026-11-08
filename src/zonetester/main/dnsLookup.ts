import type { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import { errorText } from '@app/shared/errorText'
import { RECORD_TYPES, RESOLVER_IDS, type IpcResult, type LookupResult, type RecordType, type TypeResult } from '../shared/ipc'
import { cleanName, createResolver, HOST } from './resolver'

const input = z.strictObject({
  name: z.string().trim().min(1).max(253),
  types: z.array(z.enum(RECORD_TYPES)).min(1).max(RECORD_TYPES.length),
  resolver: z.enum(RESOLVER_IDS)
})

const NO_ANSWER: Record<string, string> = {
  ENODATA: 'No records of this type',
  ENOTFOUND: 'The name does not exist',
  ESERVFAIL: 'The DNS server failed to answer',
  EREFUSED: 'The DNS server refused the query',
  ETIMEOUT: 'The DNS server did not answer in time',
  ECONNREFUSED: 'Could not reach the DNS server'
}

const cnameNote = (name: string): string =>
  name.split('.').length <= 2
    ? `No CNAME, a domain's root can't have one, so look up a subdomain such as www.${name}`
    : 'No CNAME, proxied Cloudflare records answer with addresses instead'

/** Formatted like dig. */
async function lookup(r: Resolver, name: string, type: RecordType): Promise<string[]> {
  switch (type) {
    case 'A':
      return (await r.resolve4(name, { ttl: true })).map((x) => `${x.address}  (TTL ${x.ttl})`)
    case 'AAAA':
      return (await r.resolve6(name, { ttl: true })).map((x) => `${x.address}  (TTL ${x.ttl})`)
    case 'CNAME':
      return r.resolveCname(name)
    case 'MX':
      return (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((x) => `${x.priority} ${x.exchange}`)
    case 'TXT':
      return (await r.resolveTxt(name)).map((parts) => parts.join(''))
    case 'NS':
      return r.resolveNs(name)
    case 'SOA': {
      const s = await r.resolveSoa(name)
      return [`${s.nsname} ${s.hostmaster} serial ${s.serial}, refresh ${s.refresh}, retry ${s.retry}, expire ${s.expire}, min TTL ${s.minttl}`]
    }
    case 'CAA':
      return (await r.resolveCaa(name)).map((x) => {
        const [tag, value] = Object.entries(x).find(([k]) => k !== 'critical') ?? ['', '']
        return `${x.critical} ${tag} "${String(value)}"`
      })
    case 'SRV':
      return (await r.resolveSrv(name)).map((x) => `${x.priority} ${x.weight} ${x.port} ${x.name}`)
    case 'PTR':
      return r.resolvePtr(name)
  }
}

/** Each type is queried separately, so one failure doesn't hide the rest. */
export async function dnsLookup(raw: unknown): Promise<IpcResult<LookupResult>> {
  const i = input.safeParse(raw)
  if (!i.success) return { ok: false, error: 'Choose at least one record type.' }
  const name = cleanName(i.data.name)
  // IPs do a reverse lookup
  const ip = isIP(name)
  if (!ip && !HOST.test(name)) return { ok: false, error: `${name} isn't a valid domain name.` }
  const resolver = createResolver(i.data.resolver)

  const results: TypeResult[] = await Promise.all(
    i.data.types.map(async (type): Promise<TypeResult> => {
      const started = Date.now()
      try {
        const records = ip ? (type === 'PTR' ? await resolver.reverse(name) : []) : await lookup(resolver, name, type)
        return { type, records, error: ip && type !== 'PTR' ? 'Look up a domain name for this record type' : null, ms: Date.now() - started }
      } catch (e) {
        const code = (e as { code?: string }).code ?? ''
        // An empty CNAME answer is normal, so explain why
        const cnameHint = type === 'CNAME' && code === 'ENODATA' ? cnameNote(name) : null
        return { type, records: [], error: cnameHint ?? NO_ANSWER[code] ?? errorText(e), ms: Date.now() - started }
      }
    })
  )
  return { ok: true, value: { name, resolver: i.data.resolver, results } }
}
