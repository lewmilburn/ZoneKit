import type { Change, Entry, Profile } from '../../shared/model'
import type { EmailSettings, MailSettings } from '../../shared/schemas'
import type { ItemAdapter, ReadResult } from '../sync/adapter'
import { CfApiError, type CfClient, type Zone } from '../cloudflare/client'
import { createEmailAdapter } from './email'
import { createMailAdapter } from './mail'

const MAIL_AREAS = new Set(['mx', 'routing'])
const REPORTS = 'dmarcreports'
const REPORTS_ON: Entry = { key: REPORTS, area: REPORTS, value: true }
const areaOf = (c: Change): string => (c.type === 'extra' ? c.actual : c.type === 'different' ? c.desired : c.entry).area
const isMail = (c: Change): boolean => MAIL_AREAS.has(areaOf(c))
const isMailEntry = (e: Entry): boolean => MAIL_AREAS.has(e.area)

/** Cloudflare's DMARC Management, on or not yet. */
async function readReports(client: CfClient, zone: Zone): Promise<ReadResult> {
  try {
    const r = await client.get<{ enabled?: boolean }>(`/zones/${zone.id}/email/auth/dmarc-reports`)
    return { entries: r.enabled ? [REPORTS_ON] : [], unavailable: [] }
  } catch (e) {
    if (e instanceof CfApiError && e.status === 403) return { entries: [], unavailable: [REPORTS] }
    throw e
  }
}
const merge = (a: ReadResult, b: ReadResult): ReadResult => ({
  entries: [...a.entries, ...b.entries],
  unavailable: [...a.unavailable, ...b.unavailable],
  warnings: [...(a.warnings ?? []), ...(b.warnings ?? [])]
})
const EMPTY: ReadResult = { entries: [], unavailable: [] }

/** Unset `mx` means mail servers aren't managed. */
function asMail(p: Profile<EmailSettings>): Profile<MailSettings> | null {
  if (p.settings.mx === undefined) return null
  return { ...p, settings: { mx: p.settings.mx, ...(p.settings.routes === undefined ? {} : { routes: p.settings.routes }) } }
}

/** Mail servers, forwarding, SPF, DMARC and DKIM in one profile. */
export function createEmailProfileAdapter(): ItemAdapter<EmailSettings> {
  const email = createEmailAdapter()
  const mail = createMailAdapter()
  return {
    item: 'email',

    desired(profile, zone) {
      const m = asMail(profile)
      return [...email.desired(profile, zone), ...(m ? mail.desired(m, zone) : []), ...(profile.settings.dmarcReports === 'cloudflare' ? [REPORTS_ON] : [])]
    },

    async read(client, zone, profile) {
      const m = asMail(profile)
      const [a, b, c] = await Promise.all([
        email.read(client, zone, profile),
        m ? mail.read(client, zone, m) : EMPTY,
        profile.settings.dmarcReports === 'cloudflare' ? readReports(client, zone) : EMPTY
      ])
      return merge(merge(a, b), c)
    },

    async readForImport(client, zone, profile) {
      const all = { ...profile, settings: { ...profile.settings, mx: profile.settings.mx ?? [] } }
      const [a, b] = await Promise.all([email.readForImport ? email.readForImport(client, zone, profile) : email.read(client, zone, profile), mail.read(client, zone, asMail(all) as Profile<MailSettings>)])
      return merge(a, b)
    },

    async apply(client, zone, desired, changes, unavailable) {
      const isReports = (c: Change): boolean => areaOf(c) === REPORTS
      const other = changes.filter((c) => !isMail(c) && !isReports(c))
      if (other.length > 0) await email.apply(client, zone, desired.filter((e) => !isMailEntry(e) && e.area !== REPORTS), other, unavailable)
      const mine = changes.filter(isMail)
      if (mine.length > 0) await mail.apply(client, zone, desired.filter(isMailEntry), mine, unavailable)
      // After DMARC is written, so Cloudflare adds its address to it
      if (!unavailable.includes(REPORTS) && changes.some((c) => isReports(c) && c.type === 'add')) {
        await client.send('PATCH', `/zones/${zone.id}/email/auth/dmarc-reports`, { enabled: true })
      }
    },

    addToProfile(profile, zone, change) {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      if (change.actual.area === REPORTS) return { ...profile, settings: { ...profile.settings, dmarcReports: 'cloudflare' } }
      if (!MAIL_AREAS.has(change.actual.area)) return email.addToProfile(profile, zone, change)
      const m = asMail(profile) ?? { ...profile, settings: { mx: [] } }
      const out = mail.addToProfile(m, zone, change).settings
      return { ...profile, settings: { ...profile.settings, mx: out.mx, ...(out.routes === undefined ? {} : { routes: out.routes }) } }
    }
  }
}
