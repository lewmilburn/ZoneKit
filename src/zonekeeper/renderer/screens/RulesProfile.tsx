import { useState } from 'preact/hooks'
import { ProfileRuleList } from '../components/RuleForm'
import { SettingText, Tabs } from '../components/ui'
import { RULE_SECTION_GROUPS } from '../../shared/ruleSections'
import { describeIssues, RULES_PHASES, rulesSettingsSchema, type RulesSettings } from '../../shared/schemas'

export interface RulesProfileProps {
  settings: RulesSettings
  onChange: (settings: RulesSettings) => void
}

type Section = (typeof RULES_PHASES)[number] | 'pageRules' | 'bulkRedirects'
const FIRST: Section = 'http_request_dynamic_redirect'
// Bulk Redirects are off in this build.
const SECTIONS = RULE_SECTION_GROUPS.filter((g) => g.heading === 'Rules').flatMap((g) => g.items)

function sectionValue(s: RulesSettings, section: Section): unknown[] {
  if (section === 'pageRules' || section === 'bulkRedirects') return s[section]
  return s.phases[section]
}

function withSection(s: RulesSettings, section: Section, value: unknown[]): unknown {
  if (section === 'pageRules' || section === 'bulkRedirects') return { ...s, [section]: value }
  return { ...s, phases: { ...s.phases, [section]: value } }
}

/** Text values can use {zone}. */
export function RulesProfile({ settings, onChange }: RulesProfileProps) {
  const [section, setSection] = useState<Section>(FIRST)
  const [text, setText] = useState(() => JSON.stringify(sectionValue(settings, FIRST), null, 2))
  const [error, setError] = useState<string | null>(null)
  const isPhase = section !== 'pageRules' && section !== 'bulkRedirects'

  function commit(next: unknown): void {
    const r = rulesSettingsSchema.safeParse(next)
    if (!r.success) {
      setError(describeIssues(r.error))
      return
    }
    setError(null)
    setText(JSON.stringify(sectionValue(r.data, section), null, 2))
    onChange(r.data)
  }

  function choose(next: Section): void {
    setSection(next)
    setError(null)
    setText(JSON.stringify(sectionValue(settings, next), null, 2))
  }

  function saveJson(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setError('This is not valid JSON.')
      return
    }
    if (!Array.isArray(parsed)) {
      setError('This section must be a JSON array.')
      return
    }
    commit(withSection(settings, section, parsed))
  }

  return (
    <section>
      <Tabs<Section>
        inline
        tabs={SECTIONS.map((i) => [i.id as Section, `${i.label} (${sectionValue(settings, i.id as Section).length})`] as const)}
        active={section}
        onChange={choose}
      />
      {isPhase && <ProfileRuleList key={section} phase={section} rules={sectionValue(settings, section) as Record<string, unknown>[]} onChange={(rules) => commit(withSection(settings, section, rules))} />}
      <details open={!isPhase}>
        <summary>Advanced: edit as JSON</summary>
        <SettingText label="JSON" multiline value={text} onChange={setText} />
        <div className="actions">
          <button type="button" onClick={saveJson}>Save JSON</button>
        </div>
      </details>
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  )
}
