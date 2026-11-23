/**
 * Organization Service
 * Service layer for handling organization-related operations using Better Auth
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authClient } from '@/app/lib/auth-client'
import { useToast } from '@/hooks/use-toast'
import { Organization, User } from './auth-service'

// Slugs reserved by the portal routing layer. Must stay in sync with
// `RESERVED_PORTAL_SLUGS` in apps/dashboard/middleware.ts.
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

// Types
export interface CreateOrganizationRequest {
  name: string
  organizationInfo?: string
  website?: string
  linkedin?: string
  logo?: string
  /** Custom slug for customer portal subdomain (e.g., 'acme' → acme.example.com) */
  slug?: string
}

export interface UpdateOrganizationRequest {
  name?: string
  organizationInfo?: string
  website?: string
  linkedin?: string
  logo?: string
}

export interface OrganizationWithRole extends Organization {
  role: string
  isDefault: boolean
  joinedAt: string
}

export interface CurrentOrganizationResponse {
  user: User
  hasOrg: boolean
  orgs: OrganizationWithRole[]
}

/**
 * Organization Service using Better Auth organization plugin.
 * Every operation goes through Better Auth's session-based API.
 */
export const organizationService = {
  /**
   * Get current user's organization using Better Auth
   * @returns CurrentOrganizationResponse with user and organization data
   */
  getCurrentOrganization: async (): Promise<CurrentOrganizationResponse> => {
    const { data: session } = await authClient.getSession()
    const { data: orgs } = await authClient.organization.list()

    return {
      user: session?.user as unknown as User,
      hasOrg: (orgs?.length ?? 0) > 0,
      orgs: (orgs || []).map((org: any) => ({
        ...org,
        // Org-list DISPLAY label only; NOT a security gate. members[0] is the
        // org's FIRST member (creator/owner), not necessarily the viewer — but
        // nothing authz reads this. Real gating is the api-nest/server-action
        // backend guards, which look the viewer up by userId.
        role: org.members?.[0]?.role || 'member',
        isDefault: org.id === session?.session?.activeOrganizationId,
        joinedAt: org.createdAt || new Date().toISOString(),
      })) as OrganizationWithRole[],
    }
  },

  /**
   * Create a new organization using Better Auth
   * Supports multi-organization: users can create multiple organizations
   * Different users can have orgs with the same name (unique slug generated per creation)
   * @param data Organization creation data
   * @returns Created organization object
   */
  createOrganization: async (
    data: CreateOrganizationRequest
  ): Promise<OrganizationWithRole> => {
    // Generate a readable slug with no random suffix: slugs are user-facing
    // in the URL (portal.example.com/<slug>/...). Collisions are handled
    // server-side: Better-Auth rejects duplicates and the code below retries
    // with a numeric suffix (-2, -3, ...).
    let slug: string
    let baseSlug: string
    if (data.slug && data.slug.length >= 3) {
      baseSlug = data.slug.toLowerCase().replace(/[^a-z0-9-]/g, '')
      slug = baseSlug
    } else {
      baseSlug = data.name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
      slug = baseSlug
    }

    // Reserved slugs would shadow portal routing paths (/r/, /api/, etc.)
    // — bump them to `<base>-2` so they're still creatable but never collide.
    if (RESERVED_PORTAL_SLUGS.has(slug)) {
      slug = `${baseSlug}-2`
    }

    console.log(
      '[OrgService] Creating new organization:',
      data.name,
      'slug:',
      slug,
      'customSlug:',
      !!data.slug
    )

    const result = await authClient.organization.create({
      name: data.name,
      slug,
      logo: data.logo || undefined,
      metadata: {
        website: data.website || '',
        linkedin: data.linkedin || '',
        organizationInfo: data.organizationInfo || '',
      },
    })

    if (result.error) {
      // Slug collision — try with a numeric suffix. Increment until we find
      // an unused one (capped to avoid an infinite loop in pathological
      // cases). Keeps user-facing slugs readable: acme, acme-2, acme-3, ...
      if (
        result.error.message?.includes('already exists') ||
        result.error.code === 'ORG_ALREADY_EXISTS'
      ) {
        console.log('[OrgService] Slug conflict, retrying with numeric suffix')
        const retrySlug = `${baseSlug}-2`

        const retryResult = await authClient.organization.create({
          name: data.name,
          slug: retrySlug,
          logo: data.logo || undefined,
          metadata: {
            website: data.website || '',
            linkedin: data.linkedin || '',
            organizationInfo: data.organizationInfo || '',
          },
        })

        if (retryResult.error) {
          throw new Error(
            retryResult.error.message || 'Failed to create organization'
          )
        }

        const retryOrg = retryResult.data
        if (retryOrg?.id) {
          await authClient.organization.setActive({
            organizationId: retryOrg.id,
          })
        }

        return {
          id: retryOrg?.id || '',
          name: retryOrg?.name || data.name,
          slug: retryOrg?.slug || retrySlug,
          logo: retryOrg?.logo || null,
          website: data.website || null,
          role: 'owner',
          isDefault: true,
          joinedAt: new Date().toISOString(),
        } as unknown as OrganizationWithRole
      }
      throw new Error(result.error.message || 'Failed to create organization')
    }

    const org = result.data

    // Set as active organization after creation
    if (org?.id) {
      console.log(
        '[OrgService] New organization created, setting as active:',
        org.id
      )
      await authClient.organization.setActive({ organizationId: org.id })
    }

    return {
      id: org?.id || '',
      name: org?.name || data.name,
      slug: org?.slug || slug,
      logo: org?.logo || null,
      website: data.website || null,
      role: 'owner',
      isDefault: true,
      joinedAt: new Date().toISOString(),
    } as unknown as OrganizationWithRole
  },

  /**
   * Check if user already has an organization with a similar name
   * Used by onboarding UI to show warning message
   * @param name Organization name to check
   * @returns Existing org if found, null otherwise
   */
  checkExistingOrgByName: async (
    name: string
  ): Promise<OrganizationWithRole | null> => {
    const { data: existingOrgs } = await authClient.organization.list()

    if (!existingOrgs || existingOrgs.length === 0) {
      return null
    }

    // Check if user has an org with same name (case-insensitive)
    const normalizedName = name.toLowerCase().trim()
    const matchingOrg = existingOrgs.find(
      (org: any) => org.name.toLowerCase().trim() === normalizedName
    )

    if (matchingOrg) {
      return {
        id: matchingOrg.id,
        name: matchingOrg.name,
        slug: matchingOrg.slug,
        logo: matchingOrg.logo || null,
        website: null,
        role: 'owner',
        isDefault: false,
        joinedAt: matchingOrg.createdAt || new Date().toISOString(),
      } as unknown as OrganizationWithRole
    }

    return null
  },

  /**
   * Update an organization using Better Auth
   * @param organizationId ID of the organization to update
   * @param data Organization update data
   * @returns Updated organization object
   */
  updateOrganization: async (
    organizationId: string,
    data: UpdateOrganizationRequest
  ): Promise<OrganizationWithRole> => {
    const result = await authClient.organization.update({
      organizationId,
      data: {
        name: data.name,
        logo: data.logo || undefined,
        metadata: {
          website: data.website || '',
          linkedin: data.linkedin || '',
          organizationInfo: data.organizationInfo || '',
        },
      },
    })

    if (result.error) {
      throw new Error(result.error.message || 'Failed to update organization')
    }

    const org = result.data
    return {
      id: org?.id || organizationId,
      name: org?.name || data.name || '',
      slug: org?.slug || '',
      logo: org?.logo || null,
      website: data.website || null,
      role: 'owner',
      isDefault: true,
      joinedAt: new Date().toISOString(),
    } as unknown as OrganizationWithRole
  },

  /**
   * Delete an organization using Better Auth
   * @param organizationId ID of the organization to delete
   * @returns Response with success status
   */
  deleteOrganization: async (organizationId: string) => {
    const result = await authClient.organization.delete({ organizationId })

    if (result.error) {
      throw new Error(result.error.message || 'Failed to delete organization')
    }

    return { success: true }
  },

  /**
   * Switch active organization using Better Auth
   * @param organizationId ID of the organization to switch to
   * @returns Updated organization list with the new default
   */
  switchOrganization: async (
    organizationId: string
  ): Promise<OrganizationWithRole[]> => {
    const result = await authClient.organization.setActive({ organizationId })

    if (result.error) {
      throw new Error(result.error.message || 'Failed to switch organization')
    }

    // Fetch updated list
    const { data: orgs } = await authClient.organization.list()

    return (orgs || []).map((org: any) => ({
      ...org,
      // Org-list DISPLAY label only; NOT a security gate. members[0] is the org's
      // FIRST member (creator/owner), not necessarily the viewer — but nothing
      // authz reads this. Real gating is the api-nest/server-action backend
      // guards, which look the viewer up by userId.
      role: org.members?.[0]?.role || 'member',
      isDefault: org.id === organizationId,
      joinedAt: org.createdAt || new Date().toISOString(),
    })) as OrganizationWithRole[]
  },
}

// React Query Hooks

/**
 * Hook for getting the current organization
 * Uses React Query's useQuery for state management and caching
 */
export function useCurrentOrganization(enabled?: boolean) {
  // Check if user is authenticated via Better Auth
  const { data: session } = authClient.useSession()
  const isAuthenticated = !!session?.user

  return useQuery({
    queryKey: ['organization', 'current'],
    queryFn: async () => {
      const response = await organizationService.getCurrentOrganization()
      return response
    },
    enabled: isAuthenticated && enabled !== false,
    staleTime: 5000, // Consider data fresh for 5 seconds
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    refetchOnReconnect: true,
    retry: 1,
  })
}

/**
 * Hook for creating a new organization
 * Uses React Query's useMutation for state management
 */
export function useCreateOrganization() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: (data: CreateOrganizationRequest) =>
      organizationService.createOrganization(data),

    onSuccess: async () => {
      // Invalidate organization queries to refresh data
      queryClient.invalidateQueries({ queryKey: ['organization'] })

      toast({
        title: 'Success',
        description: 'Organization created successfully',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description:
          error.response?.data?.message || 'Failed to create organization',
      })
    },
  })
}

/**
 * Hook for updating an organization
 * Uses React Query's useMutation for state management
 */
export function useUpdateOrganization() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string
      data: UpdateOrganizationRequest
    }) => organizationService.updateOrganization(id, data),

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization'] })
      toast({
        title: 'Success',
        description: 'Organization updated successfully',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description:
          error.response?.data?.message || 'Failed to update organization',
      })
    },
  })
}

/**
 * Hook for deleting an organization
 * Uses React Query's useMutation for state management
 */
export function useDeleteOrganization() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: (id: string) => organizationService.deleteOrganization(id),

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization'] })
      toast({
        title: 'Success',
        description: 'Organization deleted successfully',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description:
          error.response?.data?.message || 'Failed to delete organization',
      })
    },
  })
}

/**
 * Hook for switching the active organization
 * Uses React Query's useMutation for state management
 */
export function useSwitchOrganization() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: (id: string) => organizationService.switchOrganization(id),

    onSuccess: async () => {
      // Invalidate organization queries to refresh data
      queryClient.invalidateQueries({ queryKey: ['organization'] })

      toast({
        title: 'Success',
        description: 'Organization switched successfully',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description:
          error.response?.data?.message || 'Failed to switch organization',
      })
    },
  })
}
