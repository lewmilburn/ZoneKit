import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { RuleCounts } from '../../shared/ipc'

/** Cached until a sync or refresh clears it. */
const cache = new Map<string, RuleCounts | null>()
const waiting = new Set<() => void>()
const queue: string[] = []
let running = 0

/** A few zones at a time, for the rate limit. */
function pump(): void {
  while (running < 4 && queue.length > 0) {
    const id = queue.shift() as string
    running++
    void window.zonekeeper
      .zoneRuleCount(id)
      .then((r) => cache.set(id, r.ok ? r.value : null))
      .catch(() => cache.set(id, null))
      .finally(() => {
        running--
        for (const w of waiting) w()
        pump()
      })
  }
}

export function forgetRuleCounts(): void {
  cache.clear()
}

/** A zone's WAF or other rule count. */
export function RuleCountBadge({ zoneId, kind }: { zoneId: string; kind: keyof RuleCounts }): JSX.Element | null {
  const [, bump] = useState(0)
  useEffect(() => {
    const w = (): void => bump((n) => n + 1)
    waiting.add(w)
    if (!cache.has(zoneId) && !queue.includes(zoneId)) {
      queue.push(zoneId)
      pump()
    }
    return () => void waiting.delete(w)
  }, [zoneId])
  const c = cache.get(zoneId)
  if (!c) return null
  return <span className="badge" aria-label={`${c[kind]} rules`}>{c[kind]}</span>
}
