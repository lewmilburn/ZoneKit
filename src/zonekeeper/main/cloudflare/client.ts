import { redact } from '../redact'

export const API_BASE = 'https://api.cloudflare.com/client/v4'
/** Longer Retry-After values fail instead, so nothing looks stuck. */
export const MAX_RETRY_WAIT_MS = 30 * 1000
const MAX_PAGES = 1000

export class CfApiError extends Error {
  readonly status: number
  readonly code?: number
  readonly retryAfterMs?: number
  constructor(status: number, message: string, code?: number, retryAfterMs?: number) {
    super(message)
    this.name = 'CfApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export interface Zone {
  id: string
  name: string
  status?: string
  account?: { id: string; name?: string }
  plan?: { name?: string }
  [key: string]: unknown
}

export interface CfClientDeps {
  fetch: typeof fetch
  getToken: () => Promise<string>
  sleep?: (ms: number) => Promise<void>
  /** Default 5. */
  maxRetries?: number
}

interface Envelope<T> {
  success?: boolean
  result?: T
  errors?: Array<{ code?: number; message?: string; error_chain?: Array<{ code?: number; message?: string }> }>
  result_info?: { page?: number; total_pages?: number; cursors?: { after?: string; before?: string } }
}

/** Milliseconds, or null. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const secs = Number(header)
  if (header.trim() !== '' && Number.isFinite(secs) && secs >= 0) return secs * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0)
  return null
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000)
  return base + Math.floor(Math.random() * 250)
}

type CfError = { code?: number; message?: string; error_chain?: CfError[] }

/** Includes nested messages, which often hold the real reason. */
function describeErrors(errors: CfError[] | undefined): string {
  const out: string[] = []
  const walk = (list: CfError[] | undefined): void => {
    for (const e of list ?? []) {
      if (e.message && !out.includes(e.message)) out.push(e.message)
      walk(e.error_chain)
    }
  }
  walk(errors)
  return out.join('; ')
}

/** e.g. "settings/ssl", without IDs. */
function describePath(path: string): string {
  const parts = path.split('?')[0]!.split('/').filter(Boolean)
  const kept = parts.filter((p, i) => !(/^[a-f0-9]{32}$/i.test(p) || (i > 0 && /^(zones|accounts)$/.test(parts[i - 1]!) && p.length >= 16)))
  const tail = kept.filter((p) => p !== 'zones' && p !== 'accounts' && !/^[a-f0-9-]{20,}$/i.test(p))
  return tail.length ? tail.join('/') : kept.join('/') || 'Cloudflare'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export class CfClient {
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(private readonly deps: CfClientDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxRetries = deps.maxRetries ?? 5
  }

  get<T>(path: string): Promise<T> {
    return this.send<T>('GET', path)
  }

  async getPage<T>(path: string): Promise<{ result: T; after?: string }> {
    const env = await this.request<T>('GET', path)
    return { result: env.result as T, after: env.result_info?.cursors?.after }
  }

  async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const env = await this.request<T>(method, path, body)
    return env.result as T
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { res, token } = await this.fetchWithRetry('POST', '/graphql', { query, variables })
    let payload: unknown
    try {
      payload = await res.json()
    } catch {
      payload = undefined
    }
    if (!isRecord(payload)) {
      throw new CfApiError(res.status, `Unexpected response from Cloudflare (HTTP ${res.status}).`)
    }
    const errors = Array.isArray(payload.errors) ? (payload.errors as Array<{ message?: string }>) : []
    if (!res.ok || errors.length > 0) {
      const msg = errors.map((e) => e.message).filter(Boolean).join('; ') || `Request failed (HTTP ${res.status})`
      throw new CfApiError(res.status, `GraphQL: ${redact(msg, [token])}`)
    }
    if (payload.data === undefined || payload.data === null) {
      throw new CfApiError(res.status, 'GraphQL: response had no data.')
    }
    return payload.data as T
  }

  /** Throws rather than return a partial list. */
  async listZones(): Promise<Zone[]> {
    const zones: Zone[] = []
    let totalPages = 1
    for (let page = 1; page <= totalPages; page++) {
      if (page > MAX_PAGES) throw new CfApiError(200, 'Too many pages while listing zones.')
      const env = await this.request<Zone[]>('GET', `/zones?page=${page}&per_page=50`)
      if (!Array.isArray(env.result)) {
        throw new CfApiError(200, 'Unexpected zone list from Cloudflare.')
      }
      const info = env.result_info
      const total = info?.total_pages
      if (typeof total !== 'number' || !Number.isInteger(total) || total < 1 || total > MAX_PAGES) {
        throw new CfApiError(200, 'Zone list had no usable page count.')
      }
      if (info?.page !== undefined && info.page !== page) {
        throw new CfApiError(200, 'Zone list returned the wrong page.')
      }
      totalPages = total
      if (env.result.length === 0 && page < totalPages) {
        throw new CfApiError(200, 'Zone list ended before its last page.')
      }
      zones.push(...env.result)
    }
    return zones
  }

  /** A raw value, such as a Workers KV value, null if missing. */
  async getText(path: string): Promise<string | null> {
    const { res, token } = await this.fetchWithRetry('GET', path)
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    if (!res.ok) await this.fail('GET', path, res, token)
    return res.text()
  }

  /** Writes a raw value, such as a Workers KV value. */
  async putText(path: string, text: string): Promise<void> {
    const { res, token } = await this.fetchWithRetry('PUT', path, undefined, text)
    if (!res.ok) await this.fail('PUT', path, res, token)
    await res.body?.cancel().catch(() => {})
  }

  private async fail(method: string, path: string, res: Response, token: string, parsed?: unknown): Promise<never> {
    if (parsed === undefined) parsed = await res.json().catch(() => undefined)
    const env = isRecord(parsed) ? (parsed as Envelope<unknown>) : undefined
    const first = env?.errors?.[0]
    const detail = describeErrors(env?.errors)
    const codes = [...new Set((env?.errors ?? []).map((e) => e.code).filter((c) => c !== undefined))]
    const facts = [`HTTP ${res.status}`, ...(codes.length ? [`error ${codes.join(', ')}`] : [])].join(', ')
    const what = `${method === 'GET' ? 'Reading' : 'Changing'} ${describePath(path)} failed (${facts})`
    const text = detail ? `${what}: ${detail}` : env ? `${what}.` : `${what}: Cloudflare sent an unexpected response.`
    throw new CfApiError(res.status, redact(text, [token]), first?.code)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const { res, token } = await this.fetchWithRetry(method, path, body)
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      parsed = undefined
    }
    const env = isRecord(parsed) ? (parsed as Envelope<T>) : undefined
    if (!res.ok || !env || env.success !== true) return this.fail(method, path, res, token, parsed ?? null)
    return env
  }

  /** The token is returned for redaction. */
  private async fetchWithRetry(method: string, path: string, body?: unknown, text?: string): Promise<{ res: Response; token: string }> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      throw new Error('Invalid API path')
    }
    for (let attempt = 0; ; attempt++) {
      // Per attempt: the token may change during a backoff
      const token = await this.deps.getToken()
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (text !== undefined) headers['content-type'] = 'text/plain'
      let res: Response
      try {
        res = await this.deps.fetch(API_BASE + path, {
          method,
          headers,
          body: text ?? (body === undefined ? undefined : JSON.stringify(body))
        })
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'unknown error'
        throw new CfApiError(0, `Could not reach Cloudflare: ${redact(reason, [token])}`)
      }
      // Retry 502-504 on reads only
      const transient = res.status >= 502 && res.status <= 504 && (method === 'GET' || path === '/graphql')
      if (res.status !== 429 && !transient) return { res, token }
      const asked = parseRetryAfter(res.headers.get('retry-after'))
      if (res.status === 429 && asked !== null && asked > MAX_RETRY_WAIT_MS) {
        await res.body?.cancel().catch(() => {})
        throw new CfApiError(
          429,
          `Cloudflare is rate limiting requests, try again in ${Math.ceil(asked / 1000)} seconds.`,
          undefined,
          asked
        )
      }
      if (attempt >= this.maxRetries) return { res, token }
      await res.body?.cancel().catch(() => {})
      await this.sleep(asked ?? backoffMs(attempt))
    }
  }
}
