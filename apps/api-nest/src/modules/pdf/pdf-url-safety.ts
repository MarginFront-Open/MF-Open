import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type DnsLookupAllFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: DnsLookupAllFn = (hostname, options) => lookup(hostname, options);

function stripIpBrackets(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '');
}

function normalizeHostname(hostname: string): string {
  return stripIpBrackets(hostname).replace(/\.+$/, '').toLowerCase();
}

function isBlockedHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'local' ||
    host.endsWith('.local') ||
    host === 'internal' ||
    host.endsWith('.internal')
  );
}

function isPublicIPv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return false; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return false; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return false; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return false; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return false; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return true;
}

function parseIPv6Groups(address: string): number[] | null {
  let normalized = address.toLowerCase();

  // Convert trailing dotted-quad IPv4 (e.g., ::ffff:127.0.0.1) to two 16-bit hex groups.
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon !== -1 && normalized.slice(lastColon + 1).includes('.')) {
    const ipv4Part = normalized.slice(lastColon + 1);
    if (isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = normalized.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSegment = (segment: string): number[] | null => {
    if (!segment) return [];
    const parts = segment.split(':');
    const values: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      values.push(parseInt(part, 16));
    }
    return values;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSegment(doubleColonParts[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSegment(doubleColonParts[0]);
  const right = parseSegment(doubleColonParts[1]);
  if (!left || !right) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPublicIPv6(address: string): boolean {
  const groups = parseIPv6Groups(address);
  if (!groups) return false;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // :: (unspecified) and ::1 (loopback) and deprecated ::/96 IPv4-compatible range
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return false;
  }

  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    const c = (g7 >> 8) & 0xff;
    return isPublicIPv4Octets(a, b, c);
  }

  // fc00::/7 (unique local)
  if ((g0 & 0xfe00) === 0xfc00) return false;

  // fe80::/10 (link-local)
  if ((g0 & 0xffc0) === 0xfe80) return false;

  // ff00::/8 (multicast)
  if ((g0 & 0xff00) === 0xff00) return false;

  // 2001:db8::/32 (documentation)
  if (g0 === 0x2001 && g1 === 0x0db8) return false;

  return true;
}

/**
 * Returns true only when `ip` is a syntactically valid public unicast IPv4 or IPv6 address.
 */
export function isPublicIpAddress(ip: string): boolean {
  if (typeof ip !== 'string') return false;
  const normalized = stripIpBrackets(ip);
  const version = isIP(normalized);
  if (version === 4) {
    const [a, b, c] = normalized.split('.').map(Number);
    return isPublicIPv4Octets(a, b, c);
  }
  if (version === 6) {
    return isPublicIPv6(normalized);
  }
  return false;
}

/**
 * Returns true only for credential-free HTTPS URLs targeting non-local hostnames
 * (and, when the host is an IP literal, a public IP address).
 */
export function isSafePublicHttpsUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.trim() !== rawUrl) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;

  const host = normalizeHostname(parsed.hostname);
  if (!host || isBlockedHostname(host)) return false;

  if (isIP(host) !== 0) {
    return isPublicIpAddress(host);
  }

  return true;
}

/**
 * Resolves `hostname` via DNS (or checks an IP literal directly) and returns true
 * only when at least one address is returned and every address is public.
 */
export async function assertPublicResolvedHost(
  hostname: string,
  lookupFn: DnsLookupAllFn = defaultLookup,
): Promise<boolean> {
  if (typeof hostname !== 'string') return false;
  const host = normalizeHostname(hostname);
  if (!host || isBlockedHostname(host)) return false;

  if (isIP(host) !== 0) {
    return isPublicIpAddress(host);
  }

  try {
    const addresses = await lookupFn(host, { all: true });
    return (
      Array.isArray(addresses) &&
      addresses.length > 0 &&
      addresses.every((entry) => Boolean(entry?.address) && isPublicIpAddress(entry.address))
    );
  } catch {
    return false;
  }
}
