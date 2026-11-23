'use client'

import { useCallback, useMemo } from 'react'
import { switchOrganization as switchOrganizationAction } from '@/app/actions/switch-organization'
import { authClient } from '@/app/lib/auth-client'
import { clearTokenCache } from '@/lib/api/client'
// THE source of truth for "what is the VIEWING user's role". It looks the
// viewer up in the org member list by their own session user id — NOT
// members[0] (the org creator). The sidebar (nav-group.tsx) uses this too;
// reusing it here makes every role gate in the app agree on the same answer.
// See nav-visibility.ts for the full why.
import { resolveCurrentUserRole } from '@/components/layout/nav-visibility'

// Re-export Better Auth hooks for direct usage
export const { useSession, useActiveOrganization, useListOrganizations } =
  authClient

// Auth types exposed to components
export interface User {
  id: string
  name: string
  email: string
  role: string
  organizationId?: string
  isEmailVerified?: boolean
  status?: string
}

export interface Organization {
  id: string
  name: string
  organizationInfo?: string
  website?: string
  linkedin?: string
  logo?: string | null
  currency?: string
  timezone?: string
  onboardingComplete?: boolean
  onboardingStep?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface OrganizationWithRole extends Organization {
  role: string
  isDefault?: boolean
}

/**
 * Main auth hook: session, user, orgs and auth methods, backed by Better Auth.
 */
export function useAuth() {
  const { data: session, isPending: isLoading, error } = authClient.useSession()
  const { data: activeOrg, isPending: isActiveOrgLoading } =
    authClient.useActiveOrganization()
  const { data: orgsData, isPending: isOrgsLoading } =
    authClient.useListOrganizations()

  const isAuthenticated = useMemo(() => !!session?.user, [session?.user])

  const user: User | null = useMemo(() => {
    if (!session?.user) return null
    return {
      id: session.user.id,
      name: session.user.name || '',
      email: session.user.email || '',
      // The VIEWER's own role, resolved by their session user id, not the org
      // creator's role.
      role: resolveCurrentUserRole(activeOrg?.members, session.user.id),
      organizationId: session.session?.activeOrganizationId || undefined,
      isEmailVerified: session.user.emailVerified,
      status: 'active',
    }
  }, [session?.user, session?.session?.activeOrganizationId, activeOrg])

  const orgs: OrganizationWithRole[] = useMemo(() => {
    if (!orgsData) return []
    return orgsData.map(
      (org: {
        id: string
        name: string
        logo?: string | null
        metadata?: Record<string, unknown>
        members?: Array<{ role: string }>
      }) => ({
        id: org.id,
        name: org.name,
        logo: org.logo,
        // Switcher DISPLAY label for OTHER orgs in the list; NOT a security gate.
        // The viewer's REAL gating role is user.role (resolved via
        // resolveCurrentUserRole above) plus the api-nest/server-action backend
        // guards. No authz decision reads this members[0] value.
        role: org.members?.[0]?.role || 'member',
        isDefault: org.id === session?.session?.activeOrganizationId,
        // Map any additional fields from metadata
        currency:
          ((org.metadata as Record<string, unknown>)?.currency as string) ||
          'USD',
        timezone:
          ((org.metadata as Record<string, unknown>)?.timezone as string) ||
          'UTC',
        onboardingComplete:
          ((org.metadata as Record<string, unknown>)
            ?.onboardingComplete as boolean) || false,
        onboardingStep:
          ((org.metadata as Record<string, unknown>)?.onboardingStep as
            | string
            | null) || null,
      })
    )
  }, [orgsData, session?.session?.activeOrganizationId])

  const getUser = useCallback(() => user, [user])

  const getOrgs = useCallback(() => orgs, [orgs])

  const getOrg = useCallback(() => {
    return orgs.find((org) => org.isDefault) || orgs[0] || null
  }, [orgs])

  const getOrgId = useCallback(() => {
    // Prefer activeOrganizationId from session
    if (session?.session?.activeOrganizationId) {
      return session.session.activeOrganizationId
    }
    const defaultOrg = getOrg()
    return defaultOrg?.id || null
  }, [session?.session?.activeOrganizationId, getOrg])

  const logout = useCallback(async () => {
    try {
      // Clear token cache first
      clearTokenCache()
      // Sign out via Better Auth
      await authClient.signOut()
      // Redirect to sign-in
      window.location.href = '/sign-in'
    } catch (error) {
      console.error('[useAuth] Logout error:', error)
      // Force redirect even on error
      window.location.href = '/sign-in'
    }
  }, [])

  // Refresh user data (re-fetches session)
  const refreshUser = useCallback(async () => {
    try {
      const newSession = await authClient.getSession()
      return newSession.data
    } catch (error) {
      console.error('[useAuth] Error refreshing user:', error)
      throw error
    }
  }, [])

  // Switch organization (updates Better Auth session)
  const switchOrganization = useCallback(async (organizationId: string) => {
    try {
      // Clear token cache before switching
      clearTokenCache()

      // Call server action to update session
      const result = await switchOrganizationAction(organizationId)

      if (!result.success) {
        throw new Error(result.error || 'Failed to switch organization')
      }

      return result
    } catch (error) {
      console.error('[useAuth] Error switching organization:', error)
      throw error
    }
  }, [])

  return {
    // State
    currentUser: session ? { hasOrg: orgs.length > 0, orgs, user } : null,
    isAuthenticated,
    isLoading,
    isOrgsLoading,
    isActiveOrgLoading,
    error,
    user,
    orgs,
    session,
    activeOrganization: activeOrg,

    // Methods
    getUser,
    getOrgs,
    getOrg,
    getOrgId,
    logout,
    refreshUser,
    switchOrganization,

    // Better Auth client methods for direct access
    signIn: authClient.signIn,
    signUp: authClient.signUp,
    signOut: authClient.signOut,
  }
}

/**
 * Hook to get current organization with full details as reactive data
 */
export function useCurrentOrganization() {
  const {
    data: activeOrg,
    isPending,
    error,
  } = authClient.useActiveOrganization()
  const { data: session } = authClient.useSession()

  const organization: OrganizationWithRole | null = useMemo(() => {
    if (!activeOrg) return null
    return {
      id: activeOrg.id,
      name: activeOrg.name,
      logo: activeOrg.logo,
      // The VIEWER's own role (see useAuth above), not the creator's, so the
      // Settings > Team "View-Only Access" banner renders for non-admins.
      role: resolveCurrentUserRole(activeOrg.members, session?.user?.id),
      isDefault: true,
      currency:
        ((activeOrg.metadata as Record<string, unknown>)?.currency as string) ||
        'USD',
      timezone:
        ((activeOrg.metadata as Record<string, unknown>)?.timezone as string) ||
        'UTC',
      onboardingComplete:
        ((activeOrg.metadata as Record<string, unknown>)
          ?.onboardingComplete as boolean) || false,
      onboardingStep:
        ((activeOrg.metadata as Record<string, unknown>)?.onboardingStep as
          | string
          | null) || null,
    }
    // session?.user?.id is a dependency because the role is resolved from
    // the viewer's own id; without it the memo wouldn't refresh on user change.
  }, [activeOrg, session?.user?.id])

  return {
    organization,
    organizationId:
      session?.session?.activeOrganizationId || activeOrg?.id || null,
    isLoading: isPending,
    error,
  }
}

/**
 * Hook to get organization ID synchronously
 * Uses cached session data for immediate access
 */
export function useOrgId(): string | null {
  const { data: session } = authClient.useSession()
  return session?.session?.activeOrganizationId || null
}

/**
 * Non-hook function to get org ID for use in services
 * This is async and should be used in non-component code
 */
export async function getOrgIdAsync(): Promise<string | null> {
  try {
    const session = await authClient.getSession()
    return session.data?.session?.activeOrganizationId || null
  } catch {
    return null
  }
}

/**
 * Non-hook function to get the current user
 * This is async and should be used in non-component code
 */
export async function getCurrentUser(): Promise<User | null> {
  try {
    const session = await authClient.getSession()
    if (!session.data?.user) return null
    return {
      id: session.data.user.id,
      name: session.data.user.name || '',
      email: session.data.user.email || '',
      role: 'member',
      organizationId: session.data.session?.activeOrganizationId || undefined,
      isEmailVerified: session.data.user.emailVerified,
      status: 'active',
    }
  } catch {
    return null
  }
}

// Default export for callers that import it that way
export default useAuth
