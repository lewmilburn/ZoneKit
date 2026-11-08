import { describe, expect, it, vi } from 'vitest'
import { CfApiError, CfClient } from '../../src/zonekeeper/main/cloudflare/client'

const TOKEN = 'tok-SECRET-123456'

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function make(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, extra: { maxRetries?: number } = {}) {
  const fetchMock = vi.fn(fetchImpl)
  const sleeps: number[] = []
  const client = new CfClient({
    fetch: fetchMock as unknown as typeof fetch,
    getToken: async () => TOKEN,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...extra
  })
  return { client, fetchMock, sleeps }
}

describe('CfClient', () => {
  it('sends the bearer token and returns result', async () => {
    const { client, fetchMock } = make(async () => json(200, { success: true, result: { a: 1 } }))
    await expect(client.get('/user')).resolves.toEqual({ a: 1 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.cloudflare.com/client/v4/user')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('retries a 429 after Retry-After, then succeeds', async () => {
    let n = 0
    const { client, fetchMock, sleeps } = make(async () =>
      ++n === 1 ? json(429, { success: false, errors: [{ code: 971, message: 'slow down' }] }, { 'retry-after': '3' }) : json(200, { success: true, result: 'ok' })
    )
    await expect(client.get('/x')).resolves.toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([3000])
  })

  it('backs off even without Retry-After, and gives up after max retries with a CfApiError', async () => {
    const { client, fetchMock, sleeps } = make(async () => json(429, { success: false, errors: [] }), { maxRetries: 2 })
    const err = await client.get('/x').then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(CfApiError)
    expect((err as CfApiError).status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleeps).toHaveLength(2)
    expect(sleeps.every((s) => s > 0)).toBe(true)
  })

  it('honours a Retry-After up to 30 seconds in full', async () => {
    let n = 0
    const { client, sleeps } = make(async () =>
      ++n === 1 ? json(429, {}, { 'retry-after': '30' }) : json(200, { success: true, result: 1 })
    )
    await client.get('/x')
    expect(sleeps).toEqual([30_000])
  })

  it('fails clearly, without waiting, when Retry-After is over 30 seconds', async () => {
    const { client, fetchMock, sleeps } = make(async () => json(429, {}, { 'retry-after': '120' }))
    const err = (await client.get('/x').catch((e: unknown) => e)) as CfApiError
    expect(err).toBeInstanceOf(CfApiError)
    expect(err.status).toBe(429)
    expect(err.message).toMatch(/try again in 120 seconds/)
    expect(err.retryAfterMs).toBe(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('understands the HTTP-date form of Retry-After', async () => {
    let n = 0
    const when = new Date(Date.now() + 30_000).toUTCString()
    const { client, sleeps } = make(async () =>
      ++n === 1 ? json(429, {}, { 'retry-after': when }) : json(200, { success: true, result: 1 })
    )
    await client.get('/x')
    expect(sleeps[0]).toBeGreaterThan(20_000)
    expect(sleeps[0]).toBeLessThanOrEqual(30_000)
  })

  it('fetches a fresh token after backing off', async () => {
    let n = 0
    const seen: string[] = []
    let calls = 0
    const client = new CfClient({
      fetch: (async (_u: string, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>).authorization)
        return ++n === 1 ? json(429, {}, { 'retry-after': '1' }) : json(200, { success: true, result: 1 })
      }) as unknown as typeof fetch,
      getToken: async () => `t${++calls}`,
      sleep: async () => {}
    })
    await client.get('/x')
    expect(seen).toEqual(['Bearer t1', 'Bearer t2'])
  })

  it('a malformed 200 throws CfApiError instead of returning undefined', async () => {
    for (const res of [
      () => new Response('not json', { status: 200 }),
      () => json(200, {}),
      () => json(200, [1, 2]),
      () => json(200, { result: 'x' })
    ]) {
      const { client } = make(async () => res())
      await expect(client.get('/x')).rejects.toBeInstanceOf(CfApiError)
    }
  })

  it('graphql with a malformed or empty 200 throws CfApiError', async () => {
    for (const res of [() => new Response('nope', { status: 200 }), () => json(200, {}), () => json(200, { data: null })]) {
      const { client } = make(async () => res())
      await expect(client.graphql('q', {})).rejects.toBeInstanceOf(CfApiError)
    }
  })

  it('throws CfApiError with status, code and message for failures', async () => {
    const { client } = make(async () => json(403, { success: false, errors: [{ code: 9109, message: 'Forbidden' }] }))
    const err = (await client.get('/x').catch((e: unknown) => e)) as CfApiError
    expect(err).toBeInstanceOf(CfApiError)
    expect(err.status).toBe(403)
    expect(err.code).toBe(9109)
    expect(err.message).toContain('Forbidden')
  })

  it('treats success:false on a 200 as an error', async () => {
    const { client } = make(async () => json(200, { success: false, errors: [{ code: 1, message: 'nope' }] }))
    await expect(client.get('/x')).rejects.toBeInstanceOf(CfApiError)
  })

  it('handles non-JSON error bodies', async () => {
    const { client } = make(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    const err = (await client.get('/x').catch((e: unknown) => e)) as CfApiError
    expect(err.status).toBe(502)
  })

  it('error messages never contain the token, even if the server echoes it', async () => {
    const { client } = make(async () =>
      json(401, { success: false, errors: [{ code: 10000, message: `Invalid token ${TOKEN}` }] })
    )
    const err = (await client.get('/x').catch((e: unknown) => e)) as CfApiError
    expect(err.message).not.toContain(TOKEN)
    expect(String(err.stack)).not.toContain(TOKEN)
    expect(JSON.stringify(err)).not.toContain(TOKEN)
  })

  it('network failures do not leak the token', async () => {
    const { client } = make(async () => {
      throw new Error(`socket hang up for ${TOKEN}`)
    })
    const err = (await client.get('/x').catch((e: unknown) => e)) as Error
    expect(err.message).not.toContain(TOKEN)
  })

  it('send sends a JSON body with the method', async () => {
    const { client, fetchMock } = make(async () => json(200, { success: true, result: {} }))
    await client.send('PUT', '/zones/1/settings', { a: 1 })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('PUT')
    expect(init.body).toBe('{"a":1}')
  })

  it('rejects paths that are not API paths', async () => {
    const { client, fetchMock } = make(async () => json(200, { success: true, result: 1 }))
    await expect(client.get('https://evil.example/x')).rejects.toThrow()
    await expect(client.get('//evil.example/x')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('graphql posts to /graphql and returns data; GraphQL errors throw', async () => {
    const { client, fetchMock } = make(async () => json(200, { data: { viewer: 1 }, errors: null }))
    await expect(client.graphql('query{}', { a: 1 })).resolves.toEqual({ viewer: 1 })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/graphql')
    const bad = make(async () => json(200, { data: null, errors: [{ message: 'denied' }] }))
    await expect(bad.client.graphql('q', {})).rejects.toBeInstanceOf(CfApiError)
  })

  it('listZones returns every page', async () => {
    const pages: Record<string, unknown> = {
      '1': { success: true, result: [{ id: 'a', name: 'a.com' }, { id: 'b', name: 'b.com' }], result_info: { page: 1, total_pages: 3 } },
      '2': { success: true, result: [{ id: 'c', name: 'c.com' }, { id: 'd', name: 'd.com' }], result_info: { page: 2, total_pages: 3 } },
      '3': { success: true, result: [{ id: 'e', name: 'e.com' }], result_info: { page: 3, total_pages: 3 } }
    }
    const { client, fetchMock } = make(async (url) => json(200, pages[new URL(url).searchParams.get('page')!]))
    const zones = await client.listZones()
    expect(zones.map((z) => z.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  describe('listZones never truncates silently', () => {
    const z = (id: string) => ({ id, name: `${id}.com` })
    const run = (pages: Record<string, unknown>) =>
      make(async (url) => {
        const p = new URL(url).searchParams.get('page')!
        return json(200, pages[p])
      }).client.listZones()

    it('an empty page before the last throws', async () => {
      await expect(
        run({
          '1': { success: true, result: [z('a')], result_info: { page: 1, total_pages: 3 } },
          '2': { success: true, result: [], result_info: { page: 2, total_pages: 3 } }
        })
      ).rejects.toBeInstanceOf(CfApiError)
    })
    it('a missing result_info throws', async () => {
      await expect(run({ '1': { success: true, result: [z('a')] } })).rejects.toBeInstanceOf(CfApiError)
    })
    it('a non-array result throws', async () => {
      await expect(
        run({ '1': { success: true, result: null, result_info: { page: 1, total_pages: 1 } } })
      ).rejects.toBeInstanceOf(CfApiError)
    })
    it('a wrong page number throws (no infinite loop on a repeated page)', async () => {
      await expect(
        run({ '1': { success: true, result: [z('a')], result_info: { page: 1, total_pages: 2 } }, '2': { success: true, result: [z('a')], result_info: { page: 1, total_pages: 2 } } })
      ).rejects.toBeInstanceOf(CfApiError)
    })
    it('an absurd total_pages throws', async () => {
      await expect(
        run({ '1': { success: true, result: [z('a')], result_info: { page: 1, total_pages: 1e9 } } })
      ).rejects.toBeInstanceOf(CfApiError)
    })
    it('an account with no zones returns an empty list', async () => {
      await expect(run({ '1': { success: true, result: [], result_info: { page: 1, total_pages: 1 } } })).resolves.toEqual([])
    })
  })
})
