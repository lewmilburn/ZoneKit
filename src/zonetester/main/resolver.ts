import { Resolver } from 'node:dns/promises'
import { RESOLVERS, type ResolverId } from '../shared/ipc'

export function createResolver(id: ResolverId): Resolver {
  const resolver = new Resolver({ timeout: 4000, tries: 2 })
  const servers = RESOLVERS[id].servers
  if (servers.length > 0) resolver.setServers([...servers])
  return resolver
}

export const HOST = /^(?=.{1,253}$)(?!-)[A-Za-z0-9_-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9_-]{1,63}(?<!-))*\.?$/

/** Accepts a pasted URL too. */
export const cleanName = (raw: string): string => raw.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/\.$/, '').toLowerCase()

/** Runs `work` over `items`, `limit` at a time. */
export async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i] as T)
    }
  })
  await Promise.all(runners)
  return out
}
