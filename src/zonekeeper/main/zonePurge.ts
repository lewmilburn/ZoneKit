import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult } from '../shared/ipc'
import { CfApiError, type CfClient } from './cloudflare/client'

const input = z.strictObject({
  zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  kind: z.enum(['everything', 'files', 'hosts', 'prefixes', 'tags']),
  values: z.array(z.string().trim().min(1).max(2048)).max(100),
  /** Invalidate marks files stale instead of deleting. */
  mode: z.enum(['purge', 'invalidate']).default('purge'),
  confirmed: z.literal(true)
})

export function createZonePurgeHandler(deps: { client: Pick<CfClient, 'send'> }) {
  return async (raw: unknown): Promise<IpcResult<null>> => {
    const i = input.safeParse(raw)
    if (!i.success) return { ok: false, error: 'That purge request was not valid.' }
    const { zoneId, kind, values, mode } = i.data
    if (kind !== 'everything' && values.length === 0) return { ok: false, error: `Add at least one entry to ${mode}.` }
    try {
      await deps.client.send('POST', `/zones/${zoneId}/${mode === 'invalidate' ? 'invalidate_cache' : 'purge_cache'}`, kind === 'everything' ? { purge_everything: true } : { [kind]: values })
      return { ok: true, value: null }
    } catch (e) {
      if (e instanceof CfApiError && e.status === 403) return { ok: false, error: "Your token doesn't have Cache Purge for this zone." }
      return { ok: false, error: errorText(e) }
    }
  }
}
