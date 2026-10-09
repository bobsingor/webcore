// internalBinding('url'): Node's URL class is a thin layer over ada (C++), reading component
// offsets from `urlComponents`. The host's WHATWG URL parser produces the same hrefs; the offsets
// are derived from it using ada's url_aggregator conventions.
import type { Realm } from '../realm.ts'
import { host } from '../host.ts'

const OMITTED = 0xffffffff
// ada::scheme::type
const SCHEME_TYPES: Record<string, number> = { 'http:': 0, 'https:': 2, 'ws:': 3, 'ftp:': 4, 'wss:': 5, 'file:': 6 }
// urlUpdateActions in lib/internal/url.js
const SETTERS = ['protocol', 'host', 'hostname', 'port', 'username', 'password', 'pathname', 'search', 'hash', 'href'] as const

export function urlBinding(realm: Realm) {
  const urlComponents = new Uint32Array(9)

  /** Publishes `url`'s component offsets and returns its href. */
  const publish = (url: URL): string => {
    const href = url.href
    const protocolEnd = url.protocol.length
    let usernameEnd = protocolEnd
    let hostStart = protocolEnd
    let hostEnd = protocolEnd
    let pathnameStart = protocolEnd
    if (href.startsWith('//', protocolEnd)) {
      const authorityStart = protocolEnd + 2
      usernameEnd = authorityStart + url.username.length
      hostStart = url.password ? usernameEnd + 1 + url.password.length : usernameEnd
      const hostnameStart = url.username || url.password ? hostStart + 1 : hostStart
      hostEnd = hostnameStart + url.hostname.length
      pathnameStart = hostEnd + (url.port ? url.port.length + 1 : 0)
    }
    const hashStart = href.indexOf('#', pathnameStart)
    let searchStart = href.indexOf('?', pathnameStart)
    if (hashStart !== -1 && searchStart > hashStart) searchStart = -1
    urlComponents[0] = protocolEnd
    urlComponents[1] = usernameEnd
    urlComponents[2] = hostStart
    urlComponents[3] = hostEnd
    urlComponents[4] = url.port ? Number(url.port) : OMITTED
    urlComponents[5] = pathnameStart
    urlComponents[6] = searchStart === -1 ? OMITTED : searchStart
    urlComponents[7] = hashStart === -1 ? OMITTED : hashStart
    urlComponents[8] = SCHEME_TYPES[url.protocol] ?? 1
    return href
  }

  const invalid = (input: string, base?: string): Error => {
    const { ERR_INVALID_URL } = (realm.requireBuiltin('internal/errors') as { codes: Record<string, new (...args: unknown[]) => Error> }).codes
    return new ERR_INVALID_URL(input, base)
  }

  return {
    urlComponents,
    parse: (input: string, base: string | undefined, raiseException: boolean) => {
      try {
        return publish(base === undefined ? new host.URL(input) : new host.URL(input, base))
      } catch {
        if (raiseException) throw invalid(input, base)
        return undefined
      }
    },
    canParse: (input: string, base?: string) => (base === undefined ? host.URL.canParse(input) : host.URL.canParse(input, base)),
    update: (href: string, action: number, value: string) => {
      const url = new host.URL(href)
      const setter = SETTERS[action]
      if (setter === 'href') {
        try {
          return publish(new host.URL(value))
        } catch {
          return false
        }
      }
      // WHATWG setters ignore invalid values, which matches Node keeping the old URL when ada fails.
      ;(url as unknown as Record<string, string>)[setter] = value
      return publish(url)
    },
    format: (href: string, fragment: boolean, _unicode: boolean, search: boolean, auth: boolean) => {
      const url = new host.URL(href)
      if (!fragment) url.hash = ''
      if (!search) url.search = ''
      if (!auth) {
        url.username = ''
        url.password = ''
      }
      return url.href
    },
    getOrigin: (href: string) => new host.URL(href).origin,
    domainToASCII: (domain: string) => {
      try {
        return new host.URL(`ws://${domain}`).hostname
      } catch {
        return ''
      }
    },
    domainToUnicode: (domain: string) => domain,
    pathToFileURL: (path: string, _windows: boolean, hostname?: string) => {
      const url = new host.URL('file://')
      if (hostname) url.hostname = hostname
      // The pathname setter percent-encodes '?', '#' and spaces; these need explicit escaping.
      url.pathname = path.replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/\t/g, '%09')
      return publish(url)
    },
  }
}
