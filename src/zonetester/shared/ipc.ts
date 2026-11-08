export const CHANNELS = { dnsLookup: 'zonetester:dns-lookup', findSubdomains: 'zonetester:find-subdomains', testTls: 'zonetester:test-tls', testEmail: 'zonetester:test-email', explainRecord: 'zonetester:explain-record', runTestssl: 'zonetester:run-testssl', testsslStatus: 'zonetester:testssl-status', testsslOutput: 'zonetester:testssl-output' } as const

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'SRV', 'PTR'] as const
export type RecordType = (typeof RECORD_TYPES)[number]

/** "system" uses the OS resolver. */
export const RESOLVERS = {
  system: { name: 'System', servers: [] as string[] },
  cloudflare: { name: 'Cloudflare 1.1.1.1', servers: ['1.1.1.1', '1.0.0.1'] },
  google: { name: 'Google 8.8.8.8', servers: ['8.8.8.8', '8.8.4.4'] },
  quad9: { name: 'Quad9 9.9.9.9', servers: ['9.9.9.9', '149.112.112.112'] }
} as const
export type ResolverId = keyof typeof RESOLVERS
export const RESOLVER_IDS = Object.keys(RESOLVERS) as [ResolverId, ...ResolverId[]]

export interface LookupInput {
  name: string
  types: RecordType[]
  resolver: ResolverId
}

export interface TypeResult {
  type: RecordType
  /** Display text, e.g. "10 mail.example.com". */
  records: string[]
  error: string | null
  ms: number
}

export interface LookupResult {
  name: string
  resolver: ResolverId
  results: TypeResult[]
}

export interface TestsslInput {
  host: string
  port: number
}

export interface TestsslStatus {
  installed: boolean
  /** First-time download size. */
  downloadMb: number
}

export interface TestsslFinding {
  id: string
  /** OK, INFO, LOW, MEDIUM, HIGH, CRITICAL or WARN. */
  severity: string
  finding: string
  cve: string | null
  ip: string
}

export interface TestsslResult {
  host: string
  port: number
  findings: TestsslFinding[]
  ms: number
}

export interface ExplainInput {
  name: string
  type: RecordType
  /** The record as shown in the lookup. */
  text: string
  resolver: ResolverId
}

export interface Explanation {
  title: string
  summary: string
  details: Array<readonly [string, string]>
  notes: Array<{ level: 'bad' | 'warn' | 'good'; text: string }>
}

export const SUBDOMAIN_SOURCES = ['wordlist', 'records', 'certificates', 'variations'] as const
export type SubdomainSource = (typeof SUBDOMAIN_SOURCES)[number]

export interface SubdomainInput {
  domain: string
  sources: SubdomainSource[]
  resolver: ResolverId
}

export interface Subdomain {
  name: string
  addresses: string[]
  cname: string | null
  sources: SubdomainSource[]
  /** Answers like any made-up name, so may not really exist. */
  wildcard: boolean
}

export interface SubdomainResult {
  domain: string
  subdomains: Subdomain[]
  /** Names found that no longer resolve. */
  stale: string[]
  /** Wildcard DNS answers every name. */
  wildcard: boolean
  ms: number
}

export interface TlsInput {
  host: string
  port: number
}

export const TLS_VERSIONS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'] as const
export type TlsVersion = (typeof TLS_VERSIONS)[number]

export interface TlsProtocol {
  version: TlsVersion
  /** Null if this computer can't test it. */
  supported: boolean | null
  cipher: string | null
}

export interface TlsFinding {
  level: 'bad' | 'warn' | 'good'
  text: string
}

export interface TlsResult {
  host: string
  port: number
  protocols: TlsProtocol[]
  certificate: {
    subject: string
    issuer: string
    names: string[]
    validFrom: string
    validTo: string
    daysLeft: number
    keyBits: number | null
    trusted: boolean
    trustError: string | null
  } | null
  hsts: string | null
  findings: TlsFinding[]
}

export interface EmailInput {
  domain: string
  resolver: ResolverId
}

export interface EmailCheck {
  name: string
  records: string[]
  findings: TlsFinding[]
}

export interface EmailResult {
  domain: string
  checks: EmailCheck[]
  ms: number
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Exposed as `window.zonetester`. */
export interface ZonetesterApi {
  dnsLookup(input: LookupInput): Promise<IpcResult<LookupResult>>
  findSubdomains(input: SubdomainInput): Promise<IpcResult<SubdomainResult>>
  testTls(input: TlsInput): Promise<IpcResult<TlsResult>>
  testEmail(input: EmailInput): Promise<IpcResult<EmailResult>>
  explainRecord(input: ExplainInput): Promise<IpcResult<Explanation>>
  runTestssl(input: TestsslInput): Promise<IpcResult<TestsslResult>>
  testsslStatus(): Promise<IpcResult<TestsslStatus>>
  /** Returns an unsubscribe function. */
  onTestsslOutput(listener: (line: string) => void): () => void
}
