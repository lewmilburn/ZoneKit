/** Starting points only: check against each provider's docs. */
export interface MailProvider {
  id: string
  label: string
  mx: Array<{ content: string; priority: number }>
  spfInclude: string
  dkim: Array<{ selector: string; target: string }>
}

export const MAIL_PROVIDERS: readonly MailProvider[] = [
  {
    id: 'cloudflare',
    label: 'Cloudflare Email Routing',
    mx: [
      { content: 'route1.mx.cloudflare.net', priority: 10 },
      { content: 'route2.mx.cloudflare.net', priority: 20 },
      { content: 'route3.mx.cloudflare.net', priority: 30 }
    ],
    spfInclude: '_spf.mx.cloudflare.net',
    dkim: []
  },
  {
    id: 'purelymail',
    label: 'Purelymail',
    mx: [{ content: 'mailserver.purelymail.com', priority: 50 }],
    spfInclude: '_spf.purelymail.com',
    dkim: [
      { selector: 'purelymail1', target: 'key1.dkimroot.purelymail.com' },
      { selector: 'purelymail2', target: 'key2.dkimroot.purelymail.com' },
      { selector: 'purelymail3', target: 'key3.dkimroot.purelymail.com' }
    ]
  },
  { id: 'google', label: 'Google Workspace', mx: [{ content: 'smtp.google.com', priority: 1 }], spfInclude: '_spf.google.com', dkim: [] },
  {
    id: 'fastmail',
    label: 'Fastmail',
    mx: [
      { content: 'in1-smtp.messagingengine.com', priority: 10 },
      { content: 'in2-smtp.messagingengine.com', priority: 20 }
    ],
    spfInclude: 'spf.messagingengine.com',
    dkim: []
  },
  { id: 'microsoft', label: 'Microsoft 365', mx: [], spfInclude: 'spf.protection.outlook.com', dkim: [] }
]

/** `purelymail1` or `purelymail1._domainkey.{zone}` gives `purelymail1`. */
export function dkimSelector(input: string): string {
  return input.trim().split('._domainkey')[0]!.trim()
}

export type SpfAll = '~all' | '-all' | '?all'

export interface SpfParts {
  includes: string[]
  own: string[]
  /** Kept as written, e.g. ip4: entries. */
  other: string
  all: SpfAll
}

export function parseSpf(value: string): SpfParts {
  const tokens = value.trim().split(/\s+/).slice(1)
  const parts: SpfParts = { includes: [], own: [], other: '', all: '~all' }
  const other: string[] = []
  for (const t of tokens) {
    if (t.startsWith('include:')) parts.includes.push(t.slice('include:'.length))
    else if (t === 'a' || t === 'mx') parts.own.push(t)
    else if (t === '~all' || t === '-all' || t === '?all') parts.all = t
    else other.push(t)
  }
  parts.other = other.join(' ')
  return parts
}

export function formatSpf(p: SpfParts): string {
  return ['v=spf1', ...p.own, ...p.includes.map((i) => `include:${i}`), ...(p.other.trim() ? [p.other.trim()] : []), p.all].join(' ')
}

export type DmarcPolicy = 'none' | 'quarantine' | 'reject'

/** Unknown tags are kept. */
export function parseDmarc(value: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const part of value.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) tags.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  return tags
}

export function formatDmarc(tags: Map<string, string>): string {
  const rest = [...tags].filter(([k]) => k !== 'v' && k !== 'p')
  return ['v=DMARC1', `p=${tags.get('p') ?? 'none'}`, ...rest.map(([k, v]) => `${k}=${v}`)].join('; ')
}
