/** Display grouping, as in the Cloudflare dashboard. */
export interface RuleSectionItem {
  /** A rules phase, or 'pageRules'. */
  id: string
  label: string
  /** Page Rules are only editable in the profile editor. */
  profileOnly?: boolean
}

export interface RuleSectionGroup {
  heading: string
  items: RuleSectionItem[]
}

export const RULE_SECTION_GROUPS: readonly RuleSectionGroup[] = [
  { heading: 'Cache', items: [{ id: 'http_request_cache_settings', label: 'Cache rules' }] },
  { heading: 'Security', items: [{ id: 'http_request_firewall_custom', label: 'WAF rules' }] },
  {
    heading: 'Rules',
    items: [
      { id: 'http_request_dynamic_redirect', label: 'Redirect rules' },
      { id: 'http_request_late_transform', label: 'Request header rules' },
      { id: 'http_response_headers_transform', label: 'Response header rules' },
      { id: 'pageRules', label: 'Page Rules', profileOnly: true }
    ]
  }
]

export const RULE_SECTION_LABELS: Record<string, string> = Object.fromEntries(RULE_SECTION_GROUPS.flatMap((g) => g.items.map((i) => [i.id, i.label])))
