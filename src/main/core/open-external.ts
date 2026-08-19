import { shell } from 'electron'
import { assertOpenable } from '../../shared/external-url.js'

/**
 * Hand a URL to the user's browser.
 *
 * Failures are thrown rather than swallowed. This began life as
 * `void shell.openExternal(url)`, so a rejection looked exactly like a click
 * that never registered: nothing happened and nothing said why.
 */
export async function openExternal(url: string): Promise<void> {
  assertOpenable(url)
  await shell.openExternal(url)
}
