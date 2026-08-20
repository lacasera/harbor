import { app, BrowserWindow, screen, type Tray } from 'electron'
import { join } from 'node:path'
import { HarborApp } from './app.js'
import { openExternal } from './core/open-external.js'
import { resolveUserPath } from './core/shell-path.js'
import { runDiagnostics } from './diagnostics.js'
import { registerIpc } from './ipc/index.js'
import { createTray } from './tray.js'

let window: BrowserWindow | null = null
let harbor: HarborApp | null = null
let tray: Tray | null = null
/**
 * Set the moment a real quit begins, so `close` can tell the two apart.
 * Without it, closing the window and quitting the app are the same event and
 * one of the two has to be wrong.
 */
let quitting = false

function openExternalLogged(url: string): void {
  void openExternal(url).catch((err: Error) => {
    harbor?.logs.push('harbor', 'shell', `could not open ${url}: ${err.message}`)
  })
}

/**
 * The window is capped rather than free to fill the display.
 *
 * Harbor is a control panel, not a canvas: its widest content is a log line,
 * and on an ultrawide a maximised window stretches those to three thousand
 * pixels, which is unreadable. The cap is a comfortable working size — beyond
 * it there is nothing to gain, and the green button now grows to exactly this
 * instead of the whole screen.
 */
const MAX_SIZE = { width: 1680, height: 1200 }
const DEFAULT_SIZE = { width: 1440, height: 960 }

/**
 * Clamped to the display as well: a laptop screen is smaller than the cap, and
 * a window larger than the work area opens with its controls off-screen.
 */
function windowSize(): {
  width: number
  height: number
  maxWidth: number
  maxHeight: number
} {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const maxWidth = Math.min(MAX_SIZE.width, workAreaSize.width)
  const maxHeight = Math.min(MAX_SIZE.height, workAreaSize.height)
  return {
    maxWidth,
    maxHeight,
    width: Math.min(DEFAULT_SIZE.width, maxWidth),
    height: Math.min(DEFAULT_SIZE.height, maxHeight)
  }
}

function createWindow(): BrowserWindow {
  const size = windowSize()
  const win = new BrowserWindow({
    ...size,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer is a sandboxed presentation layer. It gets no filesystem,
      // no spawning, and no privileged calls — everything goes over typed IPC.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  /*
   * Closing hides; it does not quit.
   *
   * Harbor is running nginx, dnsmasq, PHP-FPM pools and containers that serve
   * the user's sites. Tearing those down because a window was closed would make
   * tidying the desktop an outage. The menu bar is where the app lives after
   * that, and Quit there is the way out.
   */
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })

  // Covers `target="_blank"`.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLogged(url)
    return { action: 'deny' }
  })

  // Covers everything else. Without this, a link with no `target` navigates
  // this window — the app is simply replaced by the site, with no way back.
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url === current) return
    try {
      // Same-origin navigation is the app itself, including a dev-server reload.
      if (new URL(url).origin === new URL(current).origin) return
    } catch {
      /* an unparseable URL is not ours; fall through and refuse it */
    }
    event.preventDefault()
    openExternalLogged(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

void app.whenReady().then(async () => {
  // Before anything else. A GUI-launched app inherits launchd's PATH, not the
  // user's, so every tool Harbor shells out to is invisible until this runs —
  // and HarborApp's constructor already probes for some of them.
  const resolved = await resolveUserPath().catch(() => null)
  if (resolved) process.env.PATH = resolved.path

  harbor = new HarborApp()
  if (resolved) {
    harbor.logs.push('harbor', 'startup', `PATH resolved from ${resolved.source}`)
  }
  registerIpc(harbor, () => window)
  await harbor.start()

  window = createWindow()
  tray = createTray(harbor, { show: showWindow, quit: () => app.quit() })

  // Reported at startup so a broken installation is visible in the log rather
  // than only as whatever symptom it happens to produce first.
  void runDiagnostics(harbor)
    .then((results) => {
      const bad = results.filter((r) => r.status !== 'ok')
      if (!bad.length) {
        harbor?.logs.push('harbor', 'startup', 'environment checks passed')
        return
      }
      for (const item of bad) {
        harbor?.logs.push(
          'harbor',
          'startup',
          `${item.status === 'fail' ? 'PROBLEM' : 'note'}: ${item.label} — ${item.detail}` +
            (item.remedy ? ` (${item.remedy})` : '')
        )
      }
    })
    .catch(() => undefined)

  // Clicking the Dock icon reopens the hidden window rather than doing nothing.
  app.on('activate', showWindow)
})

function showWindow(): void {
  if (!window || window.isDestroyed()) {
    window = createWindow()
    return
  }
  window.show()
  window.focus()
}

// A signalled app must still take its daemons down, or they orphan and hold
// their ports against the next launch.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void (async () => {
      quitting = true
      const instance = harbor
      harbor = null
      await instance?.shutdown().catch(() => undefined)
      app.exit(0)
    })()
  })
}

// Deliberately not quitting: the window is hidden, not gone, and the menu bar
// is still there. On macOS this is the normal shape for an app with a tray.
app.on('window-all-closed', () => undefined)

// Managed processes are children of this app; leaving them running after quit
// would orphan dev servers and services.
app.on('before-quit', async (event) => {
  // Read by the window's `close` handler, which must let this one through.
  quitting = true
  if (!harbor) return
  event.preventDefault()
  const instance = harbor
  harbor = null
  await instance.shutdown()
  tray?.destroy()
  app.quit()
})
