/**
 * Validate a URL before it is handed to the operating system.
 *
 * `shell.openExternal` passes anything to the OS — `file://`, `smb://`, a
 * registered custom scheme — and the URLs the renderer offers come from project
 * config and service drivers rather than from us. Only the two schemes a
 * browser is the right handler for get through.
 *
 * Lives in shared, with no Electron import, so the rule can be tested.
 */
export function assertOpenable(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Not a URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open a ${parsed.protocol} URL: ${url}`)
  }
  return parsed
}
