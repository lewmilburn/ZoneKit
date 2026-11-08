export const PROD_CSP = "default-src 'self'"

// Relaxed in dev only, for Vite's HMR.
export const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' ws://localhost:* http://localhost:*; img-src 'self' data:"

export function cspFor(dev: boolean): string {
  return dev ? DEV_CSP : PROD_CSP
}
