/** Our own pages only, or only `page` if given. */
export function isTrustedSender(url: string, devOrigin?: string, page?: string): boolean {
  try {
    const u = new URL(url)
    const origin = devOrigin ? u.origin === devOrigin : u.protocol === 'file:'
    return origin && (page === undefined || u.pathname.endsWith(`/${page}`))
  } catch {
    return false
  }
}

/** Keeps Electron out of tests. */
export interface SenderEvent {
  senderFrame: { url: string } | null
  sender: { mainFrame: unknown }
}

export function createGuard(devOrigin?: string, page?: string) {
  return <E extends SenderEvent, A extends unknown[], R>(fn: (...a: A) => R) =>
    (event: E, ...args: A): R => {
      if (!isTrustedEvent(event, devOrigin, page)) throw new Error('Untrusted sender')
      return fn(...args)
    }
}

/** Main frame only, never a sub-frame. */
export function isTrustedEvent(event: SenderEvent, devOrigin?: string, page?: string): boolean {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  return isTrustedSender(frame.url, devOrigin, page)
}
