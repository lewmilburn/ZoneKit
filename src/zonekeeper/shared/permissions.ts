export interface RequiredPermission {
  /** As named in Cloudflare's token screen. */
  name: string
  scope: 'Zone' | 'Account'
  use: string
}

// "Single Redirect Edit" covers dynamic redirects.
export const REQUIRED_PERMISSIONS: readonly RequiredPermission[] = [
  { name: 'Zone Read', scope: 'Zone', use: 'List your zones' },
  { name: 'Zone WAF Edit', scope: 'Zone', use: 'Custom rules' },
  { name: 'Transform Rules Edit', scope: 'Zone', use: 'Request and response header rules' },
  { name: 'Single Redirect Edit', scope: 'Zone', use: 'Dynamic (single) redirects' },
  { name: 'Page Rules Edit', scope: 'Zone', use: 'Page Rules' },
  { name: 'Workers KV Storage Edit', scope: 'Account', use: 'ZoneKit Cloud, optional' },
  { name: 'Bulk URL Redirects Edit', scope: 'Account', use: 'Bulk Redirects' },
  { name: 'Account Filter Lists Edit', scope: 'Account', use: 'Bulk Redirect lists' },
  { name: 'Account Rulesets Edit', scope: 'Account', use: 'Bulk Redirect rules' },
  { name: 'DNS Write', scope: 'Zone', use: 'Email and WWW records, DNSSEC' },
  { name: 'Zone Settings Edit', scope: 'Zone', use: 'TLS, cache level, TTL, Always Online and other zone settings' },
  { name: 'SSL and Certificates Edit', scope: 'Zone', use: 'TLS' },
  { name: 'Cache Rules Edit', scope: 'Zone', use: 'Cache rules' },
  { name: 'Cache Purge', scope: 'Zone', use: 'Purging the cache' },
  { name: 'Bot Management Write', scope: 'Zone', use: 'Block AI bots and other bot settings' },
  { name: 'Analytics Read', scope: 'Zone', use: 'Analytics, WAF Analytics and sampled logs' },
  { name: 'Logs Read', scope: 'Zone', use: 'Log Explorer logs' },
  { name: 'Notifications Write', scope: 'Account', use: 'Notifications such as certificate alerts' },
  { name: 'Email Routing Rules Edit', scope: 'Zone', use: 'Email Routing forwards' },
  { name: 'Email Routing Addresses Edit', scope: 'Account', use: 'Email Routing destinations' },
  { name: 'Account Settings Read', scope: 'Account', use: 'Account details' },
  { name: 'Allow Request Tracer Read', scope: 'Account', use: 'Testing rules' }
]
