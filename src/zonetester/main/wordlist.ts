const BASE = [
  'www', 'mail', 'webmail', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'email', 'autodiscover', 'autoconfig', 'owa', 'exchange', 'relay',
  'api', 'app', 'apps', 'admin', 'administrator', 'portal', 'dashboard', 'console', 'panel', 'login', 'auth', 'sso', 'id', 'accounts', 'account', 'oauth', 'identity',
  'dev', 'develop', 'development', 'staging', 'stage', 'test', 'testing', 'qa', 'uat', 'demo', 'sandbox', 'beta', 'alpha', 'preview', 'preprod', 'prod', 'production', 'old', 'new', 'legacy', 'next', 'canary',
  'blog', 'shop', 'store', 'docs', 'doc', 'help', 'support', 'status', 'news', 'forum', 'forums', 'community', 'wiki', 'kb', 'faq', 'learn', 'academy', 'events', 'careers', 'jobs', 'press', 'about', 'info',
  'cdn', 'static', 'assets', 'img', 'images', 'image', 'media', 'files', 'file', 'download', 'downloads', 'upload', 'uploads', 'content', 'video', 'videos', 'stream', 'live',
  'vpn', 'remote', 'gateway', 'gw', 'proxy', 'ns', 'dns', 'ftp', 'sftp', 'ssh', 'git', 'gitlab', 'github', 'bitbucket', 'jenkins', 'ci', 'cd', 'build', 'builds', 'deploy', 'registry', 'docker', 'k8s', 'kube',
  'db', 'database', 'mysql', 'postgres', 'sql', 'redis', 'mongo', 'elastic', 'search', 'grafana', 'monitor', 'monitoring', 'metrics', 'logs', 'log', 'kibana', 'prometheus', 'sentry', 'analytics', 'stats', 'track', 'tracking',
  'm', 'mobile', 'web', 'home', 'cloud', 'host', 'server', 'intranet', 'internal', 'extranet', 'crm', 'erp', 'hr', 'payroll', 'finance', 'sales', 'marketing', 'partners', 'partner', 'affiliate', 'affiliates', 'clients', 'client', 'customers', 'my',
  'calendar', 'chat', 'meet', 'zoom', 'teams', 'slack', 'pay', 'payments', 'billing', 'checkout', 'invoice', 'cart', 'order', 'orders',
  'cpanel', 'whm', 'plesk', 'webdisk', 'cpcalendars', 'cpcontacts', 'secure', 'ssl', 'shield', 'waf', 'firewall', 'backup', 'backups', 'archive', 'mirror', 'origin', 'edge', 'lb', 'loadbalancer',
  'office', 'portal2', 'webapp', 'service', 'services', 'svc', 'ws', 'wss', 'graphql', 'rest', 'rpc', 'grpc', 'hooks', 'webhook', 'webhooks', 'callback', 'events', 'notify', 'notifications', 'push', 'socket',
  'link', 'links', 'go', 'url', 'short', 'r', 's', 'a', 'b', 'c', 'x', 'en', 'de', 'fr', 'es', 'uk', 'us', 'eu', 'asia', 'au', 'ca', 'global', 'int',
  'mta-sts', 'dmarc', 'bimi', 'mail2', 'smtp2', 'email2', 'newsletter', 'lists', 'list', 'mailman', 'marketing2'
]

const NUMBERED = ['ns', 'mx', 'mail', 'smtp', 'web', 'www', 'app', 'api', 'srv', 'server', 'host', 'vps', 'node', 'db', 'cdn', 'edge', 'lb', 'vpn', 'dc']
const ENVS = ['dev', 'staging', 'stage', 'test', 'qa', 'uat', 'demo', 'beta', 'preprod', 'prod', 'sandbox']
const SERVICES = ['api', 'app', 'web', 'www', 'admin', 'portal', 'auth', 'dashboard', 'cdn', 'static', 'docs', 'shop', 'blog', 'mail', 'db', 'ws']

/** Common subdomain names, with numbered and per-environment variants. */
export const WORDLIST: readonly string[] = [
  ...new Set([
    ...BASE,
    ...NUMBERED.flatMap((n) => [1, 2, 3, 4].map((i) => `${n}${i}`)),
    ...NUMBERED.flatMap((n) => ['01', '02'].map((i) => `${n}${i}`)),
    ...ENVS.flatMap((e) => SERVICES.flatMap((s) => [`${e}-${s}`, `${s}-${e}`, `${s}.${e}`, `${e}${s}`]))
  ])
]

/** Spin-offs of a name already found. */
export function variations(label: string): string[] {
  const out = [1, 2, 3].map((i) => `${label}${i}`)
  for (const v of ['v2', 'new', 'old', 'dev', 'staging', 'test', 'prod', 'beta', 'internal', 'api', 'admin', 'backup']) out.push(`${label}-${v}`)
  for (const v of ['dev', 'staging', 'test', 'new', 'old', 'beta']) out.push(`${v}-${label}`)
  for (const v of ['dev', 'staging', 'test']) out.push(`${label}.${v}`, `${v}.${label}`)
  return out
}

/** Common SRV records, which often name hosts. */
export const SRV_NAMES = [
  '_autodiscover._tcp', '_caldav._tcp', '_caldavs._tcp', '_carddav._tcp', '_carddavs._tcp', '_imap._tcp', '_imaps._tcp',
  '_pop3._tcp', '_pop3s._tcp', '_submission._tcp', '_submissions._tcp', '_sip._tcp', '_sip._udp', '_sips._tcp',
  '_xmpp-client._tcp', '_xmpp-server._tcp', '_ldap._tcp', '_kerberos._tcp', '_minecraft._tcp', '_matrix._tcp'
] as const
