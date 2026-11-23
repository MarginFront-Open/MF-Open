const PLACEHOLDER_ORIGIN = 'http://same-origin.invalid'

/**
 * Returns the redirect target only when it is a path on this site, otherwise
 * null. `redirectTo` arrives in a query string anyone can write, so a full URL,
 * a protocol-relative `//host`, a backslash variant or anything a browser would
 * resolve to another origin is thrown away.
 */
export function safeRedirectPath(
  target: string | null | undefined
): string | null {
  if (!target) return null
  if (!target.startsWith('/') || target.startsWith('//')) return null
  // Browsers treat "\" as "/" and silently drop tabs and newlines, so
  // "/\host" and "/<tab>/host" both leave the site.
  if (/[\\\u0000-\u001f\u007f]/.test(target)) return null

  try {
    const resolved = new URL(target, PLACEHOLDER_ORIGIN)
    if (resolved.origin !== PLACEHOLDER_ORIGIN) return null
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`
    // Dot segments are removed while resolving, so "/..//host" comes out as
    // "//host". The value handed back is the one the browser will follow, so
    // it is the one that has to pass.
    if (path.startsWith('//')) return null
    if (new URL(path, PLACEHOLDER_ORIGIN).origin !== PLACEHOLDER_ORIGIN) {
      return null
    }
    return path
  } catch {
    return null
  }
}
