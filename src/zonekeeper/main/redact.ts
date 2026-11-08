export function redact(text: string, secrets: Array<string | undefined | null>): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]')
  }
  return out
}
