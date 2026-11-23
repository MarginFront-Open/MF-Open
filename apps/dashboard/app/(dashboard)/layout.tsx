import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import DashboardClientLayout from './DashboardClientLayout'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Server-side session and org check - runs BEFORE any client rendering
  let session = null

  try {
    session = await auth.api.getSession({
      headers: await headers(),
    })
  } catch (error) {
    console.error('[DashboardLayout] Failed to get session:', error)
    // On error, let the client-side layout handle it
  }

  // No session - redirect to sign-in with session_expired signal so middleware
  // can clear the dead cookie and render /sign-in instead of bouncing us back
  // to /home in an infinite loop (see middleware.ts: stale-session loop breaker).
  if (!session?.session) {
    redirect('/sign-in?session_expired=1')
  }

  // Check for active organization (skip for onboarding page)
  const headersList = await headers()
  const pathname = headersList.get('x-pathname') || ''

  if (!pathname.includes('/quick-onboarding')) {
    const activeOrgId = session.session.activeOrganizationId

    if (!activeOrgId) {
      // No organization - redirect to onboarding
      redirect('/quick-onboarding')
    }
  }

  // User has valid session and organization - render the client layout
  return (
    <DashboardClientLayout>{children}</DashboardClientLayout>
  )
}
