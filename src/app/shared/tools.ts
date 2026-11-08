export const SUITE_NAME = 'ZoneKit'
export const SUITE_VERSION = '0.1.0'

export const TOOLS = ['zonekeeper', 'zonetester'] as const
export type Tool = (typeof TOOLS)[number]

export const TOOL_NAMES: Record<Tool, string> = { zonekeeper: 'ZoneKeeper', zonetester: 'ZoneTester' }

/** Relative to the renderer root. */
export const PAGES = {
  launcher: 'app/renderer/index.html',
  zonekeeper: 'zonekeeper/renderer/index.html',
  zonetester: 'zonetester/renderer/index.html'
} as const
export type Page = keyof typeof PAGES

export const APP_CHANNELS = { openTool: 'app:open-tool' } as const

/** Exposed on every page as `window.zonekit`. */
export interface AppApi {
  openTool(tool: Tool): Promise<void>
}
