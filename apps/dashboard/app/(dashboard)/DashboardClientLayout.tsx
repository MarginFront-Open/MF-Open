'use client'

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth, useCurrentOrganization } from '@/hooks/use-auth'
import { useLayout } from '@/context/layout-context'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import SetupMethodModal from '@/components/setup-method-modal'
import { getSetupMethod } from '@/app/actions/setup-method'

// localStorage key prefix for "this org has already picked a setup method".
// Used as a synchronous fast path so returning users don't see the modal
// flash open before the Server Action confirms it should be closed.
const SETUP_PICKED_CACHE_PREFIX = 'mf_setup_picked_'

export default function DashboardClientLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { options } = useLayout()
  const { isAuthenticated, orgs, isLoading, activeOrganization } = useAuth()
  const { organizationId, isLoading: isOrgLoading } = useCurrentOrganization()

  // Fix hydration mismatch - only render after client mount
  const [mounted, setMounted] = useState(false)

  // Setup method modal — global, renders on every dashboard route so a
  // first-time user can't dodge it by clicking out of /home before the
  // trigger fires. Defaults to "show" so it appears on first paint without
  // waiting for a Server Action waterfall; the effect below closes it when
  // the org has already picked a method.
  const [showSetupModal, setShowSetupModal] = useState(true)

  // Resolve the org ID from either Better-Auth's active org (set client-side
  // after onboarding) or the current-organization hook. Prefer the former
  // because on a fresh signup the server-side session may not have
  // activeOrganizationId yet.
  const orgId = activeOrganization?.id ?? organizationId
  const isOnOnboarding = pathname?.includes('/quick-onboarding') ?? false

  // Determine if we should show sidebar and navbar (defaults to true if not specified)
  const showSidebar = options.sidebar !== false
  const showNavbar = options.navbar !== false

  // Set mounted after hydration
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional hydration guard
    setMounted(true)
  }, [])

  // Resolve whether to show the setup method modal once the orgId is
  // available. The synchronous localStorage cache lets returning users
  // skip the modal flash entirely; the Server Action is the source of
  // truth for first-time users (and writes to the cache on success).
  useEffect(() => {
    if (!orgId || isOnOnboarding) return

    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem(
        `${SETUP_PICKED_CACHE_PREFIX}${orgId}`
      )
      if (cached === 'true') {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: synchronous cache-hit fast path prevents the modal flash; setState fires at most once per orgId change
        setShowSetupModal(false)
        return
      }
    }

    getSetupMethod(orgId).then((result) => {
      if (result.success && result.data === null) {
        setShowSetupModal(true)
      } else {
        setShowSetupModal(false)
        if (typeof window !== 'undefined') {
          localStorage.setItem(`${SETUP_PICKED_CACHE_PREFIX}${orgId}`, 'true')
        }
      }
    })
  }, [orgId, isOnOnboarding])

  // Called when the user picks a method inside the modal. The modal itself
  // saves the choice server-side via updateSetupMethod; this just closes
  // the local state and writes the cache so the modal stays closed across
  // future page loads.
  const handleSetupComplete = useCallback(() => {
    setShowSetupModal(false)
    if (orgId && typeof window !== 'undefined') {
      localStorage.setItem(`${SETUP_PICKED_CACHE_PREFIX}${orgId}`, 'true')
    }
  }, [orgId])

  // Check org status and redirect if needed (backup client-side check)
  // Note: Server-side layout.tsx already handles primary org check
  // This is a fallback for edge cases where client state differs
  useEffect(() => {
    // Wait for auth and org data to load
    if (isLoading || isOrgLoading) return

    if (!isAuthenticated) {
      router.push('/sign-in')
      return
    }

    // Skip org checks for quick-onboarding route
    if (pathname?.includes('/quick-onboarding')) {
      return
    }

    // Wait for org data to be fetched before checking
    // Only redirect if we're sure there are no orgs (not just loading)
    if (!orgs || orgs.length === 0) {
      // Double check with active organization from Better Auth
      if (!activeOrganization && !organizationId) {
        router.push('/quick-onboarding')
        return
      }
    }
    // No onboardingComplete check: an org that exists isn't forced through
    // onboarding. The server-side layout already validates org existence.
  }, [
    isAuthenticated,
    isLoading,
    isOrgLoading,
    pathname,
    router,
    orgs,
    activeOrganization,
    organizationId,
  ])

  // Show loading until mounted (prevents hydration mismatch)
  if (!mounted) {
    return (
      <div className='flex h-screen items-center justify-center'>
        <div className='text-center'>
          <div className='mb-4 flex justify-center'>
            <div className='h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent'></div>
          </div>
          <p className='text-muted-foreground'>Loading...</p>
        </div>
      </div>
    )
  }

  // Show loading while redirecting
  if (!isAuthenticated) {
    return (
      <div className='flex h-screen items-center justify-center'>
        <div className='text-center'>
          <div className='mb-4 flex justify-center'>
            <div className='h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent'></div>
          </div>
          <p className='text-muted-foreground'>Redirecting...</p>
        </div>
      </div>
    )
  }

  // Always render providers to prevent hook count mismatch during navigation
  // Only conditionally show the sidebar/header UI based on layout options
  return (
      <SidebarProvider>
        <div className='print-grow flex h-screen w-full overflow-hidden'>
          {showSidebar && <AppSidebar />}
          <div className='flex flex-1 flex-col overflow-hidden'>
            {showNavbar && <Header />}
            <Main
              className={!showSidebar && !showNavbar ? 'w-full' : undefined}
            >
              {children}
            </Main>
          </div>
        </div>
        {/* Global setup method modal — renders on every dashboard route so
            a first-time user can't miss it by clicking out of /home before
            the trigger fires. Hidden on /quick-onboarding (they haven't
            finished onboarding yet) and once the org has picked a method. */}
        {showSetupModal && orgId && !isOnOnboarding && (
          <SetupMethodModal
            open={true}
            orgId={orgId}
            onComplete={handleSetupComplete}
          />
        )}
      </SidebarProvider>
  )
}
