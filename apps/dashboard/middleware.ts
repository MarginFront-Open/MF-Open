import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// =============================================================================
// CONFIGURATION
// =============================================================================

// Protected routes that require admin authentication.
// (Customer portal lives on a different host — see PORTAL_HOSTS below.)
const protectedAdminRoutes = [
  // Command Center pages.
  '/money',
  '/internal-ai-spend',
  '/finops',
  '/law',
  '/build',
  '/roi',
  '/mfiq',
  '/customers',
  '/invoices',
  '/subscriptions',
  '/agents',
  '/settings',
  '/organization',
  '/quick-onboarding',
  '/cost-management',
  '/month-end-close',
  '/metrics-events',
  '/developer-zone',
]

// Public admin routes that don't require authentication
const publicRoutes = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/otp',
  '/i/', // Public invoice pages
  '/thanks', // Stripe Checkout success_url lands here. The paying customer
  // isn't logged into the dashboard, so the page must be public.
  '/invite/', // Invite flow (success page, accept page)
  '/auth/google/success',
]

// =============================================================================
// PORTAL HOST DETECTION (path-based)
// =============================================================================
// Every customer portal lives at ONE host. The org slug is in the URL path
// (e.g. portal.example.com/acme/...). No wildcards, no per-org DNS, no per-org
// SSL certs.
//
// A request is a portal request when its host is the host of PORTAL_BASE_URL,
// or when the host's first DNS label is "portal" or starts with "portal-"
// (so portal.<your-domain> and preview hosts work with no configuration).
//
// Local dev: requires `portal.localhost` to alias to 127.0.0.1 in /etc/hosts
// (macOS does NOT auto-resolve nested .localhost names).
function configuredPortalHost(): string | null {
  const configured = process.env.PORTAL_BASE_URL?.trim()
  if (!configured) return null
  try {
    return new URL(configured).host.toLowerCase()
  } catch {
    return null
  }
}

function isPortalHost(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === configuredPortalHost()) return true
  const firstLabel = normalized.split('.')[0]
  return firstLabel === 'portal' || firstLabel.startsWith('portal-')
}

// Where a portal request with no organization in the path is sent. Unset means
// a plain 404: there is no built-in destination, and the portal never lists
// organizations.
function portalFallbackResponse(): NextResponse {
  const configured = process.env.PORTAL_FALLBACK_URL?.trim()
  if (configured) {
    try {
      const url = new URL(configured)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        return NextResponse.redirect(url)
      }
    } catch {
      // Not a URL: fall through to the 404.
    }
  }
  return new NextResponse('Not found', { status: 404 })
}

// Public portal routes (no portal session cookie required). The slug here
// is a placeholder — the actual route is /<slug>/login or /<slug>/verify
// etc. We match the trailing path after the slug.
const portalPublicPaths = ['/login', '/verify', '/link-error']

// Portal session cookie name
const PORTAL_SESSION_COOKIE = 'mf_portal_session'

// API routes that should pass through without middleware processing
const apiRoutes = ['/api']

// =============================================================================
// PORTAL REQUEST HANDLING
// =============================================================================

/**
 * Handle requests to a portal host.
 *
 * URL shape on the wire:
 *   /                          → bare portal root, no slug
 *   /r/<token>                 → one-time redeem (magic link / impersonate)
 *   /r/link-error              → org-less redeem failure fallback
 *   /<slug>/                   → post-auth portal home
 *   /<slug>/login              → org-aware login page
 *   /<slug>/verify             → magic-link verify intermediate
 *   /<slug>/link-error         → org-branded redeem failure
 *   /<slug>/invoices/<id>      → invoice deep link
 *   /<slug>/<anything>         → anything else under the org
 *
 * Internal routing (after rewrite):
 *   /r/<token>                 → /portal/r/<token>        (route handler)
 *   /r/link-error              → /portal/r/link-error     (org-less page)
 *   /<slug>/<rest>             → /portal/<slug>/<rest>    (under [slug])
 *
 * The middleware prepends `/portal` to non-API pathnames so Next.js
 * resolves them under the (customer-portal)/portal/[slug] tree.
 */
function handlePortalRequest(
  request: NextRequest,
  pathname: string
): NextResponse {
  // Pass through API routes — they're not under the [slug] segment.
  if (apiRoutes.some((route) => pathname.startsWith(route))) {
    return NextResponse.next()
  }

  // Bare portal root: no org context. (Don't expose a list of orgs.)
  if (pathname === '/' || pathname === '') {
    return portalFallbackResponse()
  }

  // The redeem URL family (`/r/...`) is org-agnostic — token resolves to
  // org server-side. Pass through to /portal/r/... without slug-validation.
  if (pathname === '/r' || pathname.startsWith('/r/')) {
    const url = request.nextUrl.clone()
    url.pathname = `/portal${pathname}`
    return NextResponse.rewrite(url)
  }

  // Everything else: first path segment is the org slug.
  const firstSegment = pathname.split('/')[1] ?? ''
  const restOfPath = pathname.slice(firstSegment.length + 1) // includes leading '/'

  // Reject reserved slugs at the routing layer — keeps `/r/...` and Next.js
  // internals from being shadowed by an org with the same slug.
  if (RESERVED_PORTAL_SLUGS.has(firstSegment)) {
    return portalFallbackResponse()
  }

  // Check portal session for non-public paths.
  const portalSession = request.cookies.get(PORTAL_SESSION_COOKIE)?.value
  const isPublicPortalPath =
    restOfPath === '' ||
    restOfPath === '/' ||
    portalPublicPaths.some((p) => restOfPath.startsWith(p))

  if (!portalSession && !isPublicPortalPath) {
    // Send the customer to their org's login page.
    const url = request.nextUrl.clone()
    url.pathname = `/${firstSegment}/login`
    return NextResponse.redirect(url)
  }

  // If has session and on login page, send them to the portal home.
  if (portalSession && restOfPath === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = `/${firstSegment}/`
    return NextResponse.redirect(url)
  }

  // Rewrite: /<slug>/<rest> → /portal/<slug>/<rest>
  const url = request.nextUrl.clone()
  url.pathname = `/portal${pathname}`
  return NextResponse.rewrite(url)
}

// Slugs reserved by the portal routing layer. Must stay in sync with the
// reserved list in apps/dashboard/src/services/organization-service.ts so
// the slug generator never assigns a slug that would shadow a routing path.
const RESERVED_PORTAL_SLUGS = new Set([
  'r',
  'api',
  'app',
  'www',
  'portal',
  'admin',
  'dashboard',
  'static',
  '_next',
  'favicon.ico',
])

// =============================================================================
// ADMIN APP REQUEST HANDLING
// =============================================================================
function handleMainAppRequest(
  request: NextRequest,
  pathname: string
): NextResponse {
  // Get Better Auth session cookie. On HTTPS, Better-Auth prefixes
  // the cookie name with `__Secure-` per browser security convention. On HTTP
  // (localhost dev), the bare name is used. Check all three standard forms so
  // the middleware works in every environment without env-conditional logic.
  const sessionCookie =
    request.cookies.get('better-auth.session_token')?.value ||
    request.cookies.get('__Secure-better-auth.session_token')?.value ||
    request.cookies.get('__Host-better-auth.session_token')?.value

  const isAuthenticated = !!sessionCookie

  // Check if route is protected
  const isProtectedRoute = protectedAdminRoutes.some((route) =>
    pathname.startsWith(route)
  )

  // Check if route is public auth page
  const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route))

  // Add x-pathname header for server components
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-pathname', pathname)

  // If trying to access protected route without session, redirect to sign-in
  if (isProtectedRoute && !isAuthenticated) {
    const url = request.nextUrl.clone()
    url.pathname = '/sign-in'
    url.searchParams.set('redirectTo', pathname)
    return NextResponse.redirect(url)
  }

  // If logged in and trying to access auth pages (sign-in, sign-up), redirect to home
  if (isPublicRoute && isAuthenticated && pathname.startsWith('/sign-')) {
    // Stale-session loop breaker. When (dashboard)/layout.tsx redirects here
    // with ?session_expired=1, the cookie is dead from the server's POV
    // (server-side getSession returned null). Delete all three Better-Auth
    // cookie variants so the next middleware run sees no session and renders
    // /sign-in normally instead of bouncing back to / in an infinite loop.
    if (request.nextUrl.searchParams.get('session_expired') === '1') {
      const response = NextResponse.next({
        request: { headers: requestHeaders },
      })
      response.cookies.delete('better-auth.session_token')
      response.cookies.delete('__Secure-better-auth.session_token')
      response.cookies.delete('__Host-better-auth.session_token')
      return response
    }

    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
}

// =============================================================================
// MAIN MIDDLEWARE
// =============================================================================

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const host = request.headers.get('host') || ''

  if (isPortalHost(host)) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[Middleware] Portal host=${host} pathname=${pathname}`)
    }
    return handlePortalRequest(request, pathname)
  }

  // Allow API routes to pass through on admin host
  if (apiRoutes.some((route) => pathname.startsWith(route))) {
    return NextResponse.next()
  }

  return handleMainAppRequest(request, pathname)
}

// Configure which routes to run middleware on
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - images, fonts (public assets)
     * - paths containing a dot (file extensions like .svg, .png, .ico, etc.)
     *
     * The negative lookahead must be followed by `.*` (capture the rest of
     * the path). `(?!...)*` repeats the assertion zero or more times and
     * only matches an empty string, so multi-segment paths would be skipped.
     */
    '/((?!_next/static|_next/image|_next/webpack-hmr|favicon.ico|images|fonts|.*\\..*).*)',
  ],
}
