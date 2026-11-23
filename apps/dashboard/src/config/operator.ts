/**
 * The one place the dashboard reads who runs this copy of MarginFront: the
 * operator's own docs site, support address, legal pages and name. Every
 * value is optional. When one is unset, the element that would show it is
 * hidden, so a fresh install never points its users at anyone else.
 *
 * Each NEXT_PUBLIC_ variable is written out in full on purpose: Next.js only
 * inlines a browser variable whose whole name appears in the source.
 */

export interface OperatorSettings {
  name: string | null
  supportEmail: string | null
  docsUrl: string | null
  termsUrl: string | null
  privacyUrl: string | null
}

function readOptional(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function withoutTrailingSlash(value: string | null): string | null {
  return value ? value.replace(/\/+$/, '') : null
}

export function getOperatorSettings(): OperatorSettings {
  return {
    name: readOptional(process.env.NEXT_PUBLIC_COMPANY_NAME),
    supportEmail: readOptional(process.env.NEXT_PUBLIC_SUPPORT_EMAIL),
    docsUrl: withoutTrailingSlash(
      readOptional(process.env.NEXT_PUBLIC_DOCS_URL)
    ),
    termsUrl: readOptional(process.env.NEXT_PUBLIC_TERMS_URL),
    privacyUrl: readOptional(process.env.NEXT_PUBLIC_PRIVACY_URL),
  }
}

/** A page on the operator's docs site, or null when no docs site is set. */
export function docsLink(path = ''): string | null {
  const { docsUrl } = getOperatorSettings()
  if (!docsUrl) return null
  if (!path) return docsUrl
  return `${docsUrl}${path.startsWith('/') ? path : `/${path}`}`
}

/** "© 2026 Acme", or null when no operator name is set. */
export function copyrightLine(year: number = new Date().getFullYear()) {
  const { name } = getOperatorSettings()
  return name ? `© ${year} ${name}` : null
}

const LOCAL_API_BASE_URL = 'http://localhost:4000/v1'

/**
 * The API address shown in copy-paste snippets: the same
 * NEXT_PUBLIC_API_BASE_URL the dashboard itself talks to. Falls back to the
 * local default only so a snippet never renders with a hole in it; the
 * dashboard refuses to start without the variable anyway.
 */
export function publicApiBaseUrl(): string {
  return (
    withoutTrailingSlash(readOptional(process.env.NEXT_PUBLIC_API_BASE_URL)) ??
    LOCAL_API_BASE_URL
  )
}
