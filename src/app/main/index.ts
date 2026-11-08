import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme } from 'electron'
import { APP_CHANNELS, PAGES, SUITE_NAME, TOOL_NAMES, TOOLS, type Page, type Tool } from '../shared/tools'
import { registerZonekeeper } from '../../zonekeeper/main'
import { registerZonetester } from '../../zonetester/main'
import { createGuard } from './ipcGuard'
import { lockDown, windowOptions } from './window'

const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
const devOrigin = devUrl ? new URL(devUrl).origin : undefined

/** One window per page. */
const windows = new Map<Page, BrowserWindow>()

/** Follows light or dark mode. */
function appIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(join(app.getAppPath(), 'assets/favicons', nativeTheme.shouldUseDarkColors ? 'dark.png' : 'light.png'))
}

function applyIcon(): void {
  const icon = appIcon()
  if (icon.isEmpty()) return
  if (process.platform === 'darwin') app.dock?.setIcon(icon)
  for (const w of windows.values()) if (!w.isDestroyed()) w.setIcon(icon)
}

function open(page: Page): BrowserWindow {
  const existing = windows.get(page)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }
  const launcher = page === 'launcher'
  const win = new BrowserWindow(
    windowOptions({
      preload: page,
      title: launcher ? SUITE_NAME : `${TOOL_NAMES[page]} - ${SUITE_NAME}`,
      ...(launcher ? { width: 760, height: 520, resizable: false } : {})
    })
  )
  windows.set(page, win)
  if (process.platform !== 'darwin') win.setIcon(appIcon())
  win.on('closed', () => {
    windows.delete(page)
    onClosed(page)
  })
  lockDown(win.webContents, devOrigin)
  win.once('ready-to-show', () => win.show())
  if (devUrl) void win.loadURL(new URL(PAGES[page], devUrl).toString())
  else void win.loadFile(join(__dirname, '../renderer', PAGES[page]))
  return win
}

/** Launcher closing because a tool opened. */
let handingOff = false
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

function onClosed(page: Page): void {
  if (quitting) return
  if (page === 'launcher') {
    // Closes ZoneKit
    if (!handingOff) app.quit()
    handingOff = false
    return
  }
  // Last tool closed: back to the launcher
  if (!TOOLS.some((t) => windows.has(t))) open('launcher')
}

function registerShell(): void {
  const anyPage = createGuard(devOrigin)
  ipcMain.handle(
    APP_CHANNELS.openTool,
    anyPage(async (raw: unknown) => {
      if (!(TOOLS as readonly unknown[]).includes(raw)) throw new Error('Unknown tool')
      open(raw as Tool)
      const launcher = windows.get('launcher')
      if (launcher && !launcher.isDestroyed()) {
        handingOff = true
        launcher.close()
      }
    })
  )
}

app.setName(SUITE_NAME)

app.whenReady().then(() => {
  registerShell()
  registerZonekeeper(devOrigin)
  registerZonetester(devOrigin)
  applyIcon()
  nativeTheme.on('updated', applyIcon)
  open('launcher')
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) open('launcher')
  })
})

// onClosed decides when to quit
app.on('window-all-closed', () => undefined)
