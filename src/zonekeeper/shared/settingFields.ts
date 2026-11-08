export interface SettingField {
  id: string
  label: string
  help: string
  options: ReadonlyArray<readonly [string, string]>
  /** Lowest plan that has it. */
  plan?: 'pro' | 'enterprise'
}

const RANK = { free: 0, pro: 1, business: 2, enterprise: 3 } as const

/** True if the zone's plan, e.g. "Pro Website", lacks the field. */
export function planLacks(f: SettingField, plan: string | null): boolean {
  if (!f.plan || !plan) return false
  const p = plan.toLowerCase()
  const have = p.includes('enterprise') ? 3 : p.includes('business') ? 2 : p.includes('pro') ? 1 : 0
  return have < RANK[f.plan]
}

/** Every on/off choice, Off on the left. */
export const ON_OFF = [['off', 'Off'], ['on', 'On']] as const

export const SSL_FIELDS: readonly SettingField[] = [
  { id: 'ssl', label: 'Encryption mode', help: 'How Cloudflare connects to your server.', options: [['off', 'Off'], ['flexible', 'Flexible'], ['full', 'Full'], ['strict', 'Full (strict)']] },
  { id: 'min_tls_version', label: 'Minimum TLS version', help: 'Older visitors below this version can no longer connect.', options: [['1.0', 'TLS 1.0'], ['1.1', 'TLS 1.1'], ['1.2', 'TLS 1.2'], ['1.3', 'TLS 1.3']] },
  { id: 'tls_1_3', label: 'TLS 1.3', help: 'Faster and more secure connections.', options: ON_OFF },
  { id: 'always_use_https', label: 'Always Use HTTPS', help: 'Redirects all HTTP requests to HTTPS.', options: ON_OFF },
  { id: 'automatic_https_rewrites', label: 'Automatic HTTPS Rewrites', help: 'Fixes mixed content by rewriting HTTP links where possible.', options: ON_OFF },
  { id: 'opportunistic_encryption', label: 'Opportunistic Encryption', help: 'Lets supporting browsers use an encrypted connection to your HTTP site.', options: ON_OFF },
  {
    id: 'tls_client_auth',
    label: 'Authenticated Origin Pulls',
    help: 'Lets your server refuse requests that skip Cloudflare.',
    options: ON_OFF
  }
]

export const CACHING_FIELDS: readonly SettingField[] = [
  { id: 'cache_level', label: 'Caching level', help: 'How query strings affect what is cached.', options: [['basic', 'No query string'], ['simplified', 'Ignore query string'], ['aggressive', 'Standard']] },
  {
    id: 'browser_cache_ttl',
    label: 'Browser cache TTL',
    help: 'How long browsers keep cached files.',
    options: [['0', 'Respect Existing Headers'], ['1800', '30 min'], ['14400', '4 hours'], ['86400', '1 day'], ['604800', '1 week'], ['2592000', '1 month'], ['31536000', '1 year']]
  },
  { id: 'crawler_hints', label: 'Crawler Hints', help: 'Tells search engines when content has changed.', options: ON_OFF },
  { id: 'always_online', label: 'Always Online', help: 'Serves saved pages when your server is down.', options: ON_OFF },
  { id: 'tiered_caching', label: 'Tiered Cache', help: 'Reduces requests to your server by caching through upper-tier data centres.', options: ON_OFF },
  {
    id: 'sort_query_string_for_cache',
    label: 'Query String Sort',
    help: 'Caches reordered query strings as one file.',
    plan: 'enterprise',
    options: ON_OFF
  }
]

// The CSAM email is per zone: Cloudflare masks it, so it can't be synced.
export const COMPLIANCE_FIELDS: readonly SettingField[] = [
  {
    id: 'csam_scanner',
    label: 'CSAM Scanning Tool',
    help: 'Checks cached images against known child sexual abuse material.',
    options: ON_OFF
  }
]

// Per zone only: it expires after 3 hours.
export const DEV_MODE_FIELDS: readonly SettingField[] = [
  { id: 'development_mode', label: 'Development Mode', help: 'Bypasses the cache for 3 hours.', options: ON_OFF }
]

export const SECSET_FIELDS: readonly SettingField[] = [
  {
    id: 'security_level',
    label: 'Security level',
    help: 'How readily visitors with a poor reputation get challenged.',
    options: [['off', 'Off'], ['essentially_off', 'Essentially off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['under_attack', 'Under attack']]
  },
  {
    id: 'challenge_ttl',
    label: 'Challenge passage',
    help: 'How long a visitor stays cleared after passing a challenge.',
    options: [['900', '15 min'], ['1800', '30 min'], ['3600', '1 hour'], ['14400', '4 hours'], ['86400', '1 day'], ['604800', '1 week'], ['2592000', '1 month']]
  },
  { id: 'browser_check', label: 'Browser Integrity Check', help: 'Blocks requests with suspicious browser headers.', options: ON_OFF },
  { id: 'email_obfuscation', label: 'Email Address Obfuscation', help: 'Hides email addresses on your pages from scrapers.', options: ON_OFF },
  { id: 'hotlink_protection', label: 'Hotlink Protection', help: 'Stops other sites embedding your images.', options: ON_OFF },
  { id: 'server_side_exclude', label: 'Server-side Excludes', help: 'Hides page content you mark with SSE tags from suspicious visitors.', options: ON_OFF },
  { id: 'ai_bots_protection', label: 'Block AI bots', help: 'Blocks AI crawlers, everywhere or only on pages with ads.', options: [['disabled', 'Off'], ['only_on_ad_pages', 'Ad pages only'], ['block', 'Block']] },
  { id: 'crawler_protection', label: 'AI Labyrinth', help: 'Sends misbehaving crawlers into generated decoy pages.', options: [['enabled', 'On'], ['disabled', 'Off']] },
  { id: 'is_robots_txt_managed', label: 'Managed robots.txt', help: 'Lets Cloudflare add AI crawler rules to your robots.txt.', options: ON_OFF },
  { id: 'fight_mode', label: 'Bot Fight Mode', help: 'Challenges traffic that looks like bots.', options: ON_OFF },
  { id: 'enable_js', label: 'JavaScript Detections', help: 'Runs a small script on pages to help identify bots.', options: ON_OFF }
]

export const SPEED_FIELDS: readonly SettingField[] = [
  { id: 'rocket_loader', label: 'Rocket Loader', help: 'Loads JavaScript after the page renders.', options: ON_OFF },
  { id: 'early_hints', label: 'Early Hints', help: 'Tells browsers what to load before the page arrives.', options: ON_OFF },
  { id: 'brotli', label: 'Brotli', help: 'Compresses responses to make them smaller.', options: ON_OFF },
  { id: 'http2', label: 'HTTP/2', help: 'Faster connections for browsers that support it.', options: ON_OFF },
  { id: 'http3', label: 'HTTP/3', help: 'Faster connections over QUIC.', options: ON_OFF },
  { id: '0rtt', label: '0-RTT', help: 'Speeds up repeat visits by resuming connections.', options: ON_OFF },
  { id: 'polish', label: 'Polish', help: 'Optimises images.', plan: 'pro', options: [['off', 'Off'], ['lossless', 'Lossless'], ['lossy', 'Lossy']] },
  { id: 'speed_brain', label: 'Speed Brain', help: 'Prefetches pages a visitor is likely to open next.', options: ON_OFF },
  { id: 'fonts', label: 'Cloudflare Fonts', help: 'Serves Google Fonts from your own domain, which is faster and more private.', options: ON_OFF },
  { id: 'h2_prioritization', label: 'HTTP/2 Prioritization', help: 'Sends the most important parts of a page first.', plan: 'pro', options: [['off', 'Off'], ['on', 'On'], ['custom', 'Custom']] },
  { id: 'origin_max_http_version', label: 'Origin Max HTTP Version', help: 'The highest HTTP version Cloudflare uses to reach your server.', options: [['1', 'HTTP/1.1'], ['2', 'HTTP/2']] }
]

// gRPC and Maximum Upload Size have no API.
export const NETWORK_FIELDS: readonly SettingField[] = [
  { id: 'ipv6', label: 'IPv6 Compatibility', help: 'Lets visitors reach your site over IPv6, even if your server only supports IPv4.', options: ON_OFF },
  { id: 'websockets', label: 'WebSockets', help: 'Allows WebSocket connections to your server.', options: ON_OFF },
  {
    id: 'pseudo_ipv4',
    label: 'Pseudo IPv4',
    help: 'Gives IPv6 visitors an IPv4 address in a header, for servers that only understand IPv4.',
    options: [['off', 'Off'], ['add_header', 'Add header'], ['overwrite_header', 'Overwrite headers']]
  },
  { id: 'ip_geolocation', label: 'IP Geolocation', help: "Sends the visitor's country code to your server in the CF-IPCountry header.", options: ON_OFF },
  { id: 'nel', label: 'Network Error Logging', help: 'Browsers report connection problems with your site to Cloudflare.', options: ON_OFF },
  { id: 'opportunistic_onion', label: 'Onion Routing', help: "Serves Tor visitors through Cloudflare's onion service instead of exit nodes.", options: ON_OFF },
  { id: 'true_client_ip_header', label: 'True-Client-IP Header', help: "Sends the visitor's IP in a header.", plan: 'enterprise', options: ON_OFF }
]

export const fieldIds = (fields: readonly SettingField[]): string[] => fields.map((f) => f.id)
