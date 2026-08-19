import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { HarborApp } from './app.js'
import { registerIpc } from './ipc/index.js'

let window: BrowserWindow | null = null
let harbor: HarborApp | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

void app.whenReady().then(async () => {
  harbor = new HarborApp()
  registerIpc(harbor, () => window)
  await harbor.start()

  window = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Managed processes are children of this app; leaving them running after quit
// would orphan dev servers and services.
app.on('before-quit', async (event) => {
  if (!harbor) return
  event.preventDefault()
  const instance = harbor
  harbor = null
  await instance.shutdown()
  app.quit()
})
