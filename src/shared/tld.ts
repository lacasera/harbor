/**
 * Advice on a chosen local TLD.
 *
 * Harbor points an entire suffix at 127.0.0.1, so choosing one that exists on
 * the public internet makes every real domain under it unreachable from this
 * machine. Some are worse than unreachable: Google's `.app` and `.dev` are in
 * the browsers' HSTS preload list, so they are forced to HTTPS with no way to
 * click through a certificate warning.
 */

/** Reserved by RFC 6761/8375 for exactly this purpose — always safe. */
const RESERVED = ['test', 'localhost', 'example', 'invalid', 'internal', 'home.arpa']

/** Real gTLDs people reach for, with the ones that are HSTS-preloaded marked. */
const REAL_GTLDS: Record<string, boolean> = {
  app: true,
  dev: true,
  page: true,
  new: true,
  foo: true,
  zip: true,
  mov: true,
  site: false,
  online: false,
  cloud: false,
  local: false,
  web: false
}

export interface TldAdvice {
  level: 'ok' | 'warn' | 'danger'
  message: string
}

export function adviseTld(raw: string): TldAdvice {
  const tld = raw.replace(/^\./, '').trim().toLowerCase()

  if (!tld) return { level: 'danger', message: 'A TLD is required.' }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(tld)) {
    return { level: 'danger', message: 'Use letters, digits and hyphens only.' }
  }
  if (RESERVED.includes(tld)) {
    return { level: 'ok', message: `.${tld} is reserved for local use — safe.` }
  }

  if (tld in REAL_GTLDS) {
    const preloaded = REAL_GTLDS[tld]
    return {
      level: 'danger',
      message: preloaded
        ? `.${tld} is a real public domain and is HSTS-preloaded: browsers force HTTPS on it and ` +
          `you cannot reach any genuine .${tld} site while Harbor owns it. Prefer .test.`
        : `.${tld} is a real public domain — every genuine .${tld} site becomes unreachable from ` +
          `this machine while Harbor owns it. Prefer .test.`
    }
  }

  // `.local` is claimed by mDNS/Bonjour even though it is not a gTLD.
  if (tld === 'local') {
    return {
      level: 'danger',
      message: '.local is used by Bonjour/mDNS and will conflict with network discovery.'
    }
  }

  return {
    level: 'warn',
    message: `.${tld} isn't a reserved suffix. It works today, but would collide if it is ever ` +
      `delegated as a real TLD. .test is guaranteed never to be.`
  }
}
