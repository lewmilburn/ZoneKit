/** Why a cipher would be flagged, from its IANA or OpenSSL name. */
function cipherNote(text: string): string {
  const reasons: string[] = []
  const t = text.toUpperCase()
  if (/\bRC4\b|_RC4_/.test(t)) reasons.push('RC4 is broken')
  if (/3DES|DES-CBC3|_DES_/.test(t)) reasons.push('3DES is weak (SWEET32)')
  if (/NULL/.test(t)) reasons.push('no encryption at all')
  if (/EXPORT|EXP-/.test(t)) reasons.push('export-grade, deliberately weak')
  if (/ANON|ADH|AECDH/.test(t)) reasons.push('no authentication, so open to impersonation')
  if (/MD5/.test(t)) reasons.push('MD5 is broken')
  if (/TLS_RSA_WITH|\bAES\d*-SHA|\bAES\d*-GCM-SHA|\bRSA\b(?!.*DHE)/.test(t) && !/DHE|ECDHE/.test(t)) reasons.push('no forward secrecy, so a leaked server key exposes past traffic')
  if (/CBC/.test(t) || /-SHA(256|384)?$/.test(t)) reasons.push('CBC mode is older and prone to padding attacks')
  if (/_SHA\b|-SHA$/.test(t) && !/SHA256|SHA384/.test(t)) reasons.push('SHA-1 MAC')
  return reasons.length > 0 ? `Accepted cipher: ${[...new Set(reasons)].join(', ')}` : 'Accepted cipher'
}

/** Plain explanations for testssl.sh check IDs. */
const NOTES: ReadonlyArray<readonly [RegExp, string | ((finding: string) => string)]> = [
  [/^cipher-|^cipherorder|^cipher_/, cipherNote],
  [/sig_algs/i, (f) => (/SHA1|MD5/i.test(f) ? 'Signature algorithms offered, including weak SHA-1' : 'Signature algorithms offered')],
  [/^SSLv2|^SSLv3/, 'Old SSL protocol, broken and must be off'],
  [/^TLS1$|^TLS1_1$/, 'Deprecated TLS version, should be off'],
  [/^TLS1_2$|^TLS1_3$/, 'Modern TLS version'],
  [/^FS$|^FS_/, 'Forward secrecy, which protects past traffic if the key leaks'],
  [/^HSTS/, 'Tells browsers to always use HTTPS'],
  [/^HPKP/, 'Old key pinning header, now deprecated'],
  [/^OCSP_stapling/, 'The server attaches proof its certificate is not revoked'],
  [/^cert_expiration/, 'When the certificate expires'],
  [/^cert_chain_of_trust/, 'Whether the certificate chains to a trusted root'],
  [/^cert_keySize/, 'Certificate key size'],
  [/^cert_signatureAlgorithm/, 'How the certificate is signed'],
  [/^cert_trust/, 'Whether the certificate matches the hostname'],
  [/^cert_/, 'Certificate detail'],
  [/^heartbleed/i, 'Heartbleed, leaks server memory'],
  [/^CCS/, 'CCS injection, lets an attacker decrypt traffic'],
  [/^ticketbleed/i, 'Ticketbleed, leaks memory via session tickets'],
  [/^ROBOT/, 'ROBOT, an RSA padding attack'],
  [/^secure_renego|^secure_client_renego/, 'Renegotiation, insecure if unprotected'],
  [/^CRIME/, 'CRIME, a TLS compression attack'],
  [/^BREACH/, 'BREACH, an HTTP compression attack, low risk unless pages reflect secrets'],
  [/^POODLE/, 'POODLE, an SSLv3 padding attack'],
  [/^fallback_SCSV/, 'Stops attackers forcing an older protocol'],
  [/^SWEET32/, 'SWEET32, a 64-bit block cipher attack (3DES)'],
  [/^FREAK/, 'FREAK, forces export-grade RSA'],
  [/^DROWN/, 'DROWN, uses SSLv2 to break TLS'],
  [/^LOGJAM/, 'LOGJAM, forces weak Diffie-Hellman'],
  [/^BEAST/, 'BEAST, a CBC attack on TLS 1.0 clients'],
  [/^LUCKY13/, 'LUCKY13, a CBC timing attack, mitigated in modern libraries'],
  [/^RC4/, 'RC4 cipher support'],
  [/^winshock/i, 'Winshock, a Windows TLS flaw'],
  [/^clientsimulation-/, 'How this client would connect'],
  [/^overall_grade|^final_score|^grade_cap/, 'Overall rating'],
  [/^DH_groups|^DH_/, 'Diffie-Hellman parameters'],
  [/^ALPN|^NPN/, 'Application protocols offered, such as HTTP/2'],
  [/^session_ticket|^sessionresumption/, 'Session resumption'],
  [/^banner_|^HTTP_/, 'HTTP response detail'],
  [/^cookie_/, 'Cookie flags'],
  [/^security_headers/, 'Security headers on the response']
]

export function explainFinding(id: string, finding: string): string {
  const hit = NOTES.find(([re]) => re.test(id))
  if (!hit) return ''
  return typeof hit[1] === 'string' ? hit[1] : hit[1](finding)
}
