import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ImpersonationBanner } from '@/app/(customer-portal)/components/ImpersonationBanner'
import { PortalChrome } from '@/app/(customer-portal)/components/PortalChrome'
import {
  PORTAL_SESSION_COOKIE,
  validatePortalSessionForSlug,
} from '@/app/lib/portal-auth'

interface MainPortalLayoutProps {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}

/**
 * Per-org post-auth portal layout.
 *
 * Inter-customer isolation gate: every request validates that the portal
 * session cookie belongs to a customer in the org named by `[slug]`. A
 * customer holding a session for org A who navigates to org B's URL is
 * bounced to org B's login page.
 *
 * The (auth) sibling group skips this check — login/verify/link-error pages
 * are reachable without a session.
 */
export default async function MainPortalLayout({
  children,
  params,
}: MainPortalLayoutProps) {
  const { slug } = await params

  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(PORTAL_SESSION_COOKIE)?.value

  const valid = await validatePortalSessionForSlug(sessionToken, slug)

  if (!valid) {
    redirect(`/${slug}/login`)
  }

  return (
    <div className='min-h-screen bg-background'>
      <ImpersonationBanner />
      <PortalChrome>{children}</PortalChrome>
    </div>
  )
}
