import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPublicIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return false;
  const mappedIPv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIPv4) return isPublicIPv4(mappedIPv4[1]);
  if (lower.startsWith('::ffff:')) return false;
  if (/^f[cd]/.test(lower)) return false;
  if (/^fe[89ab]/.test(lower)) return false;
  if (lower.startsWith('ff')) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version === 6) return isPublicIPv6(address);
  return false;
}

/**
 * True only for a host name that resolves to public addresses. IP literals
 * and localhost names are refused outright so a URL typed by a user can't
 * point the server at its own private network.
 */
export async function isPublicHostname(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isIP(host)) return false;
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  } catch {
    return false;
  }
}
