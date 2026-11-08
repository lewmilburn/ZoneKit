/** An error's message, ready to show. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  const text = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  return text ? text.slice(0, 500) : 'Unknown error.'
}
