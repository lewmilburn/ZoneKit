import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import suiteLogo from '../../../assets/ZoneKit.webp'
import keeperLogo from '../../../assets/ZoneKeeper.webp'
import testerLogo from '../../../assets/ZoneTester.webp'
import { errorText } from '../shared/errorText'
import { SUITE_NAME, TOOL_NAMES, type Tool } from '../shared/tools'
import { WarningBox } from './ui'

const CARDS: ReadonlyArray<{ tool: Tool; logo: string; about: string }> = [
  { tool: 'zonekeeper', logo: keeperLogo, about: 'Keep settings in sync across your Cloudflare zones with profiles.' },
  { tool: 'zonetester', logo: testerLogo, about: 'Look up and test zones from the outside.' }
]

/** Tool picker. */
export function Launcher(): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const open = (tool: Tool): void => {
    setError(null)
    if (!window.zonekit) return setError("ZoneKit didn't load properly, restart it.")
    window.zonekit.openTool(tool).catch((e: unknown) => setError(errorText(e)))
  }
  return (
    <main className="launcher">
      <img src={suiteLogo} alt={SUITE_NAME} className="launcher-logo" />
      <div className="launcher-cards">
        {CARDS.map((c) => (
          <section key={c.tool} className="launcher-card">
            <img src={c.logo} alt={TOOL_NAMES[c.tool]} />
            <p className="muted">{c.about}</p>
            <button className="primary" onClick={() => open(c.tool)}>Open {TOOL_NAMES[c.tool]}</button>
          </section>
        ))}
      </div>
      {error && <WarningBox alert>{error}</WarningBox>}
    </main>
  )
}
