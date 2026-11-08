import type { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import { errorText } from '@app/shared/errorText'
import { RECORD_TYPES, RESOLVER_IDS, type Explanation, type IpcResult, type RecordType } from '../shared/ipc'
import { createResolver } from './resolver'

const input = z.strictObject({
  name: z.string().min(1).max(253),
  type: z.enum(RECORD_TYPES),
  text: z.string().min(1).max(5000),
  resolver: z.enum(RESOLVER_IDS)
})

type Note = Explanation['notes'][number]
type Row = Explanation['details'][number]

/** Hostname suffix to provider. */
const PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.ns\.cloudflare\.com$/, 'Cloudflare DNS'],
  [/\.mx\.cloudflare\.net$/, 'Cloudflare Email Routing'],
  [/\.(pages\.dev|workers\.dev)$/, 'Cloudflare Pages or Workers'],
  [/\.cdn\.cloudflare\.net$/, 'Cloudflare'],
  [/(\.|^)google\.com$|googlemail\.com$|\.googlehosted\.com$/, 'Google'],
  [/\.outlook\.com$|\.protection\.outlook\.com$|\.office365\.com$/, 'Microsoft 365'],
  [/\.azurewebsites\.net$|\.cloudapp\.azure\.com$|\.azureedge\.net$|\.trafficmanager\.net$/, 'Microsoft Azure'],
  [/\.awsdns-\d+\.|\.amazonaws\.com$|\.cloudfront\.net$|\.elb\.amazonaws\.com$/, 'Amazon Web Services'],
  [/\.protonmail\.ch$|\.proton\.me$/, 'Proton Mail'],
  [/\.zoho\.(com|eu)$/, 'Zoho Mail'],
  [/\.purelymail\.com$/, 'Purelymail'],
  [/\.mailgun\.org$/, 'Mailgun'],
  [/\.sendgrid\.net$/, 'SendGrid'],
  [/\.github\.io$/, 'GitHub Pages'],
  [/\.netlify\.(app|com)$/, 'Netlify'],
  [/\.vercel-dns\.com$|\.vercel\.app$/, 'Vercel'],
  [/\.herokuapp\.com$|\.herokudns\.com$/, 'Heroku'],
  [/\.myshopify\.com$|shops\.myshopify\.com$/, 'Shopify'],
  [/\.domaincontrol\.com$/, 'GoDaddy DNS'],
  [/\.registrar-servers\.com$/, 'Namecheap DNS'],
  [/\.digitalocean\.com$/, 'DigitalOcean'],
  [/\.fastly\.net$/, 'Fastly'],
  [/\.akamai(edge)?\.net$|\.edgekey\.net$/, 'Akamai']
]
const providerOf = (host: string): string | null => PROVIDERS.find(([re]) => re.test(host.toLowerCase().replace(/\.$/, '')))?.[1] ?? null

/** Known TXT verification tokens. */
const VERIFICATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^google-site-verification=/i, 'Google Search Console or Workspace'],
  [/^MS=/, 'Microsoft 365'],
  [/^apple-domain-verification=/i, 'Apple'],
  [/^facebook-domain-verification=/i, 'Meta'],
  [/^atlassian-domain-verification=/i, 'Atlassian'],
  [/^docusign=/i, 'DocuSign'],
  [/^stripe-verification=/i, 'Stripe'],
  [/^zoom-domain-verification=/i, 'Zoom'],
  [/^adobe-idp-site-verification=/i, 'Adobe'],
  [/^have-i-been-pwned-verification=/i, 'Have I Been Pwned'],
  [/^keybase-site-verification=/i, 'Keybase'],
  [/^globalsign-domain-verification=/i, 'GlobalSign'],
  [/^_?(brevo|sendinblue)-code:/i, 'Brevo'],
  [/^mailchimp=|^k1\._domainkey/i, 'Mailchimp'],
  [/^(openai|anthropic)-domain-verification=/i, 'AI provider domain verification'],
  [/^cloudflare-verify/i, 'Cloudflare'],
  [/^ahrefs-site-verification_/i, 'Ahrefs']
]

const SPF_MECHANISMS: Record<string, string> = {
  include: "Also allows the servers in another domain's SPF",
  a: "Allows this domain's A and AAAA addresses",
  mx: "Allows this domain's mail servers",
  ip4: 'Allows these IPv4 addresses',
  ip6: 'Allows these IPv6 addresses',
  exists: 'Allows mail if this name resolves',
  ptr: 'Allows by reverse DNS, which is slow and discouraged',
  redirect: "Uses another domain's SPF instead",
  exp: 'Points to an explanation shown on failure',
  all: 'Matches everything else'
}
const QUALIFIER: Record<string, string> = { '+': 'pass', '-': 'fail (reject)', '~': 'soft fail (mark as suspicious)', '?': 'neutral' }

function explainSpf(txt: string): { details: Row[]; notes: Note[] } {
  const terms = txt.split(/\s+/).slice(1).filter(Boolean)
  const details: Row[] = []
  const notes: Note[] = []
  let lookups = 0
  for (const t of terms) {
    const m = /^([+\-~?]?)([a-z0-9]+)(?:[:=](.*))?$/i.exec(t)
    if (!m) continue
    const [, q = '', mech = '', arg] = m
    const key = mech.toLowerCase()
    if (['include', 'a', 'mx', 'exists', 'ptr', 'redirect'].includes(key)) lookups++
    const what = SPF_MECHANISMS[key] ?? 'Unknown mechanism'
    details.push([t, key === 'all' ? `Everything else gets ${QUALIFIER[q || '+']}` : `${what}${arg ? `: ${arg}` : ''}`])
    if (key === 'all' && (q === '' || q === '+')) notes.push({ level: 'bad', text: '+all lets anyone send as this domain' })
    if (key === 'all' && q === '?') notes.push({ level: 'warn', text: '?all gives no protection, use ~all or -all' })
    if (key === 'ptr') notes.push({ level: 'warn', text: 'ptr is deprecated and slow' })
  }
  if (!terms.some((t) => /^[+\-~?]?all$/i.test(t) || /^redirect=/i.test(t))) notes.push({ level: 'warn', text: 'No all or redirect at the end, so unmatched senders are neutral' })
  notes.push(lookups > 10 ? { level: 'bad', text: `${lookups} DNS lookups, over the limit of 10, so SPF fails` } : { level: 'good', text: `${lookups} of 10 DNS lookups used` })
  return { details, notes }
}

const tags = (txt: string): Map<string, string> =>
  new Map(txt.split(';').map((p) => p.trim()).filter(Boolean).map((p) => [p.split('=')[0]!.trim().toLowerCase(), p.slice(p.indexOf('=') + 1).trim()] as [string, string]))

function explainDmarc(txt: string): { details: Row[]; notes: Note[] } {
  const t = tags(txt)
  const POLICY: Record<string, string> = { none: 'Monitor only, nothing is blocked', quarantine: 'Failing mail goes to spam', reject: 'Failing mail is rejected' }
  const details: Row[] = [['Policy', `${t.get('p') ?? 'missing'}: ${POLICY[t.get('p') ?? ''] ?? 'unknown'}`]]
  if (t.has('sp')) details.push(['Subdomain policy', t.get('sp')!])
  if (t.has('pct')) details.push(['Applies to', `${t.get('pct')}% of mail`])
  if (t.has('rua')) details.push(['Aggregate reports to', t.get('rua')!])
  if (t.has('ruf')) details.push(['Failure reports to', t.get('ruf')!])
  if (t.has('adkim')) details.push(['DKIM alignment', t.get('adkim') === 's' ? 'Strict' : 'Relaxed'])
  if (t.has('aspf')) details.push(['SPF alignment', t.get('aspf') === 's' ? 'Strict' : 'Relaxed'])
  const notes: Note[] = []
  if (t.get('p') === 'none') notes.push({ level: 'warn', text: 'p=none only monitors, spoofed mail still gets through' })
  if (!t.has('rua')) notes.push({ level: 'warn', text: 'No rua, so you get no reports' })
  if (t.get('p') === 'reject' || t.get('p') === 'quarantine') notes.push({ level: 'good', text: 'Spoofed mail is blocked' })
  return { details, notes }
}

function explainDkim(txt: string): { details: Row[]; notes: Note[] } {
  const t = tags(txt)
  const key = t.get('p') ?? ''
  // Base64 RSA keys: roughly 1.36 chars per byte, so this estimates the modulus size
  const bits = key ? Math.round((key.length * 6) / 8 / 16) * 16 * 8 - 256 : 0
  const details: Row[] = [['Key type', t.get('k') ?? 'rsa']]
  if (key) details.push(['Key size', `about ${Math.max(bits, 0)} bits`])
  const notes: Note[] = []
  if (!key) notes.push({ level: 'warn', text: 'The key is empty, so this selector is revoked' })
  else if ((t.get('k') ?? 'rsa') === 'rsa' && bits < 1024) notes.push({ level: 'bad', text: 'RSA keys under 1024 bits are insecure' })
  else if ((t.get('k') ?? 'rsa') === 'rsa' && bits < 2048) notes.push({ level: 'warn', text: '1024-bit RSA is weak, 2048 is recommended' })
  return { details, notes }
}

function explainTxt(name: string, txt: string): Omit<Explanation, 'title'> {
  if (/^v=spf1(\s|$)/i.test(txt)) return { summary: 'SPF lists which servers may send email for this domain', ...explainSpf(txt) }
  if (/^v=DMARC1/i.test(txt)) return { summary: 'DMARC tells receivers what to do with mail that fails SPF and DKIM', ...explainDmarc(txt) }
  if (/^v=DKIM1/i.test(txt) || /\._domainkey\./i.test(name)) return { summary: 'DKIM publishes the public key used to check signed email', ...explainDkim(txt) }
  if (/^v=STSv1/i.test(txt)) return { summary: 'MTA-STS says mail servers must use TLS when sending here', details: [['Policy ID', tags(txt).get('id') ?? '']], notes: [] }
  if (/^v=TLSRPTv1/i.test(txt)) return { summary: 'TLS-RPT asks senders to report TLS problems', details: [['Reports to', tags(txt).get('rua') ?? '']], notes: [] }
  if (/^v=BIMI1/i.test(txt)) return { summary: 'BIMI shows a brand logo next to your email in some inboxes', details: [['Logo', tags(txt).get('l') ?? ''], ['Certificate', tags(txt).get('a') ?? 'None']], notes: [] }
  const verify = VERIFICATIONS.find(([re]) => re.test(txt))
  if (verify) return { summary: `A domain verification token for ${verify[1]}`, details: [], notes: [{ level: 'good', text: 'Safe to leave, but it can be removed once verified' }] }
  return { summary: 'A text record, often used to prove ownership to a service', details: [], notes: [] }
}

/** IP owner via Team Cymru's DNS service, so no web request is made. */
async function ipOwner(r: Resolver, ip: string): Promise<Row[]> {
  const v4 = isIP(ip) === 4
  const reversed = v4 ? ip.split('.').reverse().join('.') : expandV6(ip).split('').reverse().join('.')
  try {
    const [origin] = (await r.resolveTxt(`${reversed}.${v4 ? 'origin' : 'origin6'}.asn.cymru.com`)).map((p) => p.join(''))
    const [asn = '', prefix = '', country = ''] = (origin ?? '').split('|').map((s) => s.trim())
    const first = asn.split(' ')[0] ?? ''
    const [org] = first ? (await r.resolveTxt(`AS${first}.asn.cymru.com`).catch(() => [])).map((p) => p.join('')) : []
    const owner = (org ?? '').split('|').pop()?.trim() ?? ''
    return [['Network', `AS${first} ${owner}`.trim()], ['Prefix', prefix], ['Country', country]]
  } catch {
    return []
  }
}

function expandV6(ip: string): string {
  const [head = '', tail = ''] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const fill = ip.includes('::') ? Array(8 - h.length - t.length).fill('0') : []
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0')).join('')
}

function privateRange(ip: string): string | null {
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return 'a private address, not reachable from the internet'
  if (/^127\./.test(ip) || ip === '::1') return 'a loopback address'
  if (/^169\.254\./.test(ip) || /^fe80:/i.test(ip)) return 'a link-local address'
  if (/^100::/i.test(ip) || /^192\.0\.2\./.test(ip)) return 'a placeholder address that goes nowhere, used for proxied records'
  return null
}

export async function explainRecord(raw: unknown): Promise<IpcResult<Explanation>> {
  const i = input.safeParse(raw)
  if (!i.success) return { ok: false, error: 'That record could not be explained.' }
  const { name, type, text } = i.data
  const r = createResolver(i.data.resolver)
  const title = `${type} record`
  try {
    switch (type as RecordType) {
      case 'A':
      case 'AAAA': {
        const ip = text.split(/\s+/)[0] ?? ''
        const ttl = /TTL (\d+)/.exec(text)?.[1]
        const [ptr, owner] = await Promise.all([r.reverse(ip).catch(() => [] as string[]), ipOwner(r, ip)])
        const special = privateRange(ip)
        const cloudflare = owner.some(([, v]) => /AS13335\b/.test(v))
        const details: Row[] = [['Address', ip], ...(ttl ? [['TTL', `${ttl} seconds`] as Row] : []), ['Reverse DNS', ptr.join(', ') || 'None'], ...owner]
        const notes: Note[] = []
        if (special) notes.push({ level: 'warn', text: `This is ${special}` })
        if (cloudflare) notes.push({ level: 'good', text: "Proxied through Cloudflare, so the origin server's IP is hidden" })
        return { ok: true, value: { title, summary: `An ${type === 'A' ? 'IPv4' : 'IPv6'} address this name points to`, details, notes } }
      }
      case 'MX': {
        const [prio = '', host = ''] = text.split(/\s+/)
        const addrs = await r.resolve4(host).catch(() => [] as string[])
        const provider = providerOf(host)
        const notes: Note[] = addrs.length === 0 ? [{ level: 'bad', text: "The mail server doesn't resolve, so mail can't be delivered to it" }] : []
        if (host === '.' || host === '') notes.push({ level: 'good', text: 'A null MX: this domain accepts no email' })
        return {
          ok: true,
          value: { title, summary: 'A server that receives email for this domain, lower priority is tried first', details: [['Priority', prio], ['Server', host], ['Provider', provider ?? 'Unknown'], ['Addresses', addrs.join(', ') || 'None']], notes }
        }
      }
      case 'TXT':
        return { ok: true, value: { title, ...explainTxt(name, text) } }
      case 'CNAME': {
        const target = text.trim()
        const resolves = (await r.resolve4(target).catch(() => [])).length > 0 || (await r.resolve6(target).catch(() => [])).length > 0
        const provider = providerOf(target)
        const notes: Note[] = resolves ? [] : [{ level: 'bad', text: "The target doesn't resolve, so someone could take over this subdomain by claiming it" }]
        return { ok: true, value: { title, summary: 'An alias: this name uses whatever the target points to', details: [['Target', target], ['Provider', provider ?? 'Unknown']], notes } }
      }
      case 'NS': {
        const provider = providerOf(text)
        return { ok: true, value: { title, summary: 'A nameserver that answers DNS for this domain', details: [['Nameserver', text], ['Provider', provider ?? 'Unknown']], notes: [] } }
      }
      case 'CAA': {
        const m = /^(\d+)\s+(\S+)\s+"(.*)"$/.exec(text)
        const [, flags = '', tag = '', value = ''] = m ?? []
        const TAGS: Record<string, string> = { issue: 'May issue certificates', issuewild: 'May issue wildcard certificates', iodef: 'Where to report policy violations' }
        return {
          ok: true,
          value: { title, summary: 'Limits which certificate authorities may issue certificates for this domain', details: [['Rule', TAGS[tag] ?? tag], ['Value', value || 'Nobody'], ['Critical', flags === '128' ? 'Yes' : 'No']], notes: [] }
        }
      }
      case 'SOA': {
        const m = /^(\S+) (\S+) serial (\d+), refresh (\d+), retry (\d+), expire (\d+), min TTL (\d+)$/.exec(text)
        const [, ns = '', mail = '', serial = '', refresh = '', retry = '', expire = '', min = ''] = m ?? []
        return {
          ok: true,
          value: {
            title,
            summary: "The zone's settings for secondary nameservers and caching",
            details: [
              ['Primary nameserver', ns],
              ['Admin email', mail.replace('.', '@')],
              ['Serial', serial],
              ['Refresh', `${refresh}s, how often secondaries check for changes`],
              ['Retry', `${retry}s, wait before retrying a failed refresh`],
              ['Expire', `${expire}s, when secondaries stop answering`],
              ['Negative TTL', `${min}s, how long "doesn't exist" is cached`]
            ],
            notes: []
          }
        }
      }
      case 'SRV': {
        const [prio = '', weight = '', port = '', target = ''] = text.split(/\s+/)
        return {
          ok: true,
          value: { title, summary: 'Says which host and port provide a service', details: [['Host', target], ['Port', port], ['Priority', `${prio}, lower is tried first`], ['Weight', `${weight}, shares load between equal priorities`]], notes: [] }
        }
      }
      case 'PTR':
        return { ok: true, value: { title, summary: 'Reverse DNS: the name an IP address points back to', details: [['Name', text]], notes: [] } }
    }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}
