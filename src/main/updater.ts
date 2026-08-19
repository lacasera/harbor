import { app } from 'electron'
import type { LogAggregator } from './core/log-aggregator.js'
import type { UpdateStatus } from '../shared/ipc.js'

/**
 * Update checking, kept out of HarborApp on purpose: electron-updater pulls in
 * `electron`, and HarborApp is deliberately importable without it so the
 * verification scripts can drive the whole backend headlessly.
 *
 * Every outcome is reported rather than thrown. An update check failing is
 * never a reason to interrupt someone's work, but silently swallowing it means
 * nobody discovers the feed is misconfigured.
 */
export class Updater {
  constructor(private readonly logs: LogAggregator) {}

  async check(): Promise<UpdateStatus> {
    const currentVersion = app.getVersion()

    if (!app.isPackaged) {
      return {
        state: 'disabled',
        currentVersion,
        detail: 'development build — updates are only checked in a packaged app'
      }
    }

    try {
      // Imported lazily so a development run never loads it at all.
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.autoDownload = false
      autoUpdater.logger = null

      const result = await autoUpdater.checkForUpdates()
      const available = result?.updateInfo?.version
      if (available && available !== currentVersion) {
        this.logs.push('harbor', 'updater', `update available: ${available}`)
        return { state: 'available', currentVersion, availableVersion: available }
      }
      return { state: 'current', currentVersion }
    } catch (err) {
      const detail = (err as Error).message
      this.logs.push('harbor', 'updater', `update check failed: ${detail}`)
      return { state: 'error', currentVersion, detail }
    }
  }
}
