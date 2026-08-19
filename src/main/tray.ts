import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { HarborApp } from './app.js'
import { openExternal } from './core/open-external.js'

/**
 * The menu-bar presence.
 *
 * Harbor manages daemons — nginx, dnsmasq, PHP-FPM pools, containers — that go
 * on serving whether or not a window is open. Quitting on a closed window would
 * take the user's sites down as a side effect of tidying their desktop, so the
 * window closes to here instead and the app keeps running.
 *
 * The menu is rebuilt on every open rather than kept in sync. It is a handful
 * of items read from state that is already in memory, and a stale menu that
 * offers to open a project that no longer exists is worse than the rebuild.
 */
export function createTray(
  harbor: HarborApp,
  actions: { show: () => void; quit: () => void }
): Tray {
  const tray = new Tray(trayIcon())
  tray.setToolTip('Harbor — local development platform')

  const open = (): void => {
    // Built fresh: see above.
    tray.popUpContextMenu(Menu.buildFromTemplate(template(harbor, actions)))
  }
  tray.on('click', open)
  tray.on('right-click', open)
  return tray
}

function trayIcon(): Electron.NativeImage {
  // Packaged first, then the source tree for `electron-vite dev`.
  const candidates = [
    join(process.resourcesPath, 'tray'),
    join(__dirname, '../../resources/tray')
  ]

  for (const dir of candidates) {
    const file = join(dir, 'trayTemplate.png')
    if (!existsSync(file)) continue
    const image = nativeImage.createFromPath(file)
    // A template image is black-with-alpha and macOS tints it — for the light
    // menu bar, the dark one, and the highlighted state. Without this flag it
    // renders as a black square that disappears against a dark menu bar.
    image.setTemplateImage(true)
    return image
  }

  // Loud, not empty. `createEmpty()` produces a tray item with no icon: it is
  // still there and still clickable, and looks exactly like the feature not
  // working at all.
  throw new Error(`Menu-bar icon not found. Looked in: ${candidates.join(', ')}`)
}

function template(
  harbor: HarborApp,
  actions: { show: () => void; quit: () => void }
): MenuItemConstructorOptions[] {
  const projects = harbor.projects.list()
  const instances = harbor.services.all()

  // Counted from live processes rather than by health-checking every instance:
  // this runs on a click, and a menu that takes two seconds to appear is a
  // broken menu. A service Harbor started has a process; one it did not, has not.
  const running = harbor.processes
    .list()
    .filter((p) => p.owner.kind === 'service' && p.state === 'running').length

  const sites: MenuItemConstructorOptions[] = projects.map((project) => ({
    label: project.domain,
    click: () => {
      const url = `${project.secure ? 'https' : 'http'}://${project.domain}/`
      void openExternal(url).catch(() => undefined)
    }
  }))

  return [
    {
      label: `${projects.length} project${projects.length === 1 ? '' : 's'} · ${running} of ${instances.length} services running`,
      enabled: false
    },
    { type: 'separator' },
    { label: 'Open Harbor', click: actions.show },
    {
      label: 'Open a site',
      enabled: sites.length > 0,
      submenu: sites.length ? sites : [{ label: 'No projects parked', enabled: false }]
    },
    { type: 'separator' },
    {
      // The memory action. A database is around half a gigabyte each, and a
      // laptop that has stopped for the day should not be running six of them.
      label: 'Stop all services',
      enabled: running > 0,
      click: () => void harbor.services.stopAll().catch(() => undefined)
    },
    {
      // The two things that fix most `.test` weirdness, and both are otherwise
      // several clicks into the window.
      label: 'Restart nginx',
      click: () => {
        const { httpPort, httpsPort } = harbor.store.get().settings
        void harbor.projects.nginx.restart({ httpPort, httpsPort }).catch(() => undefined)
      }
    },
    {
      label: 'Flush DNS cache',
      click: () => void harbor.dns.flushDnsCache().catch(() => undefined)
    },
    { type: 'separator' },
    { label: 'Quit Harbor', click: actions.quit }
  ]
}
