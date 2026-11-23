function stripIpBrackets(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '')
}

function normalizeHostname(hostname: string): string {
  return stripIpBrackets(hostname).replace(/\.+$/, '').toLowerCase()
}

function isBlockedHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'local' ||
    host.endsWith('.local') ||
    host === 'internal' ||
    host.endsWith('.internal')
  )
}

function parseIPv4Octets(
  address: string
): [number, number, number, number] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null
    const value = Number(part)
    if (value < 0 || value > 255) return null
    octets.push(value)
  }
  return [octets[0], octets[1], octets[2], octets[3]]
}

function isPublicIPv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0) return false
  if (a === 10) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && c === 0) return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

function parseIPv6Groups(address: string): number[] | null {
  let normalized = address.toLowerCase()

  const lastColon = normalized.lastIndexOf(':')
  if (lastColon !== -1 && normalized.slice(lastColon + 1).includes('.')) {
    const octets = parseIPv4Octets(normalized.slice(lastColon + 1))
    if (!octets) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`
  }

  const doubleColonParts = normalized.split('::')
  if (doubleColonParts.length > 2) return null

  const parseSegment = (segment: string): number[] | null => {
    if (!segment) return []
    const parts = segment.split(':')
    const values: number[] = []
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      values.push(parseInt(part, 16))
    }
    return values
  }

  if (doubleColonParts.length === 1) {
    const groups = parseSegment(doubleColonParts[0])
    return groups && groups.length === 8 ? groups : null
  }

  const left = parseSegment(doubleColonParts[0])
  const right = parseSegment(doubleColonParts[1])
  if (!left || !right) return null

  const missing = 8 - (left.length + right.length)
  if (missing < 1) return null

  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

function isPublicIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return false
  }

  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0xffff
  ) {
    const a = (g6 >> 8) & 0xff
    const b = g6 & 0xff
    const c = (g7 >> 8) & 0xff
    return isPublicIPv4Octets(a, b, c)
  }

  if ((g0 & 0xfe00) === 0xfc00) return false
  if ((g0 & 0xffc0) === 0xfe80) return false
  if ((g0 & 0xff00) === 0xff00) return false
  if (g0 === 0x2001 && g1 === 0x0db8) return false

  return true
}

/**
 * Returns true only when `ip` is a public unicast IPv4 or IPv6 address.
 */
export function isPublicIpAddress(ip: string): boolean {
  if (typeof ip !== 'string') return false
  const normalized = stripIpBrackets(ip)
  const ipv4 = parseIPv4Octets(normalized)
  if (ipv4) {
    return isPublicIPv4Octets(ipv4[0], ipv4[1], ipv4[2])
  }
  const ipv6 = parseIPv6Groups(normalized)
  if (ipv6) {
    return isPublicIPv6(ipv6)
  }
  return false
}

/**
 * Returns true only for credential-free HTTPS URLs targeting non-local hostnames
 * (and, when the host is an IP literal, a public IP address).
 */
export function isSafePublicHttpsUrl(rawUrl: string): boolean {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.trim() !== rawUrl
  ) {
    return false
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false

  const host = normalizeHostname(parsed.hostname)
  if (!host || isBlockedHostname(host)) return false

  if (parseIPv4Octets(host) || host.includes(':')) {
    return isPublicIpAddress(host)
  }

  return true
}
