'use client'

import * as React from 'react'
import {
  getOrganizationsOnboardingStatus,
  OrganizationOnboardingStatus,
} from '@/app/actions/get-organizations-onboarding-status'
import { switchOrganization } from '@/app/actions/switch-organization'
import { useSwitchOrganization } from '@/services/organization-service'
import { ChevronsUpDown, Plus, Users } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useAuth, OrganizationWithRole } from '@/hooks/use-auth'
import { useToast } from '@/hooks/use-toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

// Curated palette — rich, saturated, all pass contrast for white text.
// Each org always gets the same color because the hash is deterministic.
const ORG_COLORS = [
  'bg-blue-600',
  'bg-emerald-700',
  'bg-violet-600',
  'bg-amber-600',
  'bg-rose-600',
  'bg-cyan-600',
  'bg-indigo-600',
  'bg-teal-600',
]

// FNV-1a hash — spreads even similar strings across different buckets,
// unlike djb2 which clusters names that share length or characters.
function getOrgColor(name: string): string {
  let hash = 2166136261
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return ORG_COLORS[Math.abs(hash) % ORG_COLORS.length]
}

// Organization Logo — shows the real logo if one exists, otherwise
// renders the first letter of the org name on a colored background
// so you can tell orgs apart at a glance (like Slack or Linear).
const OrgLogo = ({
  logo,
  name,
  size = 'md',
}: {
  logo?: string | null
  name: string
  size?: 'sm' | 'md'
}) => {
  const [hasError, setHasError] = React.useState(false)
  const sizeClasses = size === 'sm' ? 'size-6' : 'size-8'

  // Reset error state when logo changes
  React.useEffect(() => {
    setHasError(false)
  }, [logo])

  if (logo && !hasError) {
    return (
      <img
        src={logo}
        alt={name}
        className={cn(
          sizeClasses,
          'rounded-lg border border-sidebar-border object-cover'
        )}
        onError={() => setHasError(true)}
      />
    )
  }

  // Colored initial fallback — deterministic color per org name
  const initial = name.charAt(0).toUpperCase() || '?'

  return (
    <div
      className={cn(
        sizeClasses,
        getOrgColor(name),
        'flex items-center justify-center rounded-lg font-bold text-white'
      )}
    >
      <span className={size === 'sm' ? 'text-xs' : 'text-sm'}>{initial}</span>
    </div>
  )
}

export function TeamSwitcher() {
  const { isMobile } = useSidebar()
  const {
    orgs,
    getOrg,
    isOrgsLoading,
    isAuthenticated,
    isLoading: isSessionLoading,
    user,
  } = useAuth()
  const defaultOrg = getOrg()
  // Cosmetic gate only — /quick-onboarding?new=true is the real enforcer
  // (org creation is owner-only).
  const canAddOrg = user?.role === 'owner'
  // Same cosmetic-gate pattern — /settings/team
  // is the real enforcer. Owner/admin only; a plain member shouldn't see an
  // entry point into team management.
  const canManageTeam = user?.role === 'owner' || user?.role === 'admin'
  const [activeOrg, setActiveOrg] = React.useState<OrganizationWithRole | null>(
    defaultOrg
  )
  const [isSwitching, setIsSwitching] = React.useState(false)
  const [onboardingStatus, setOnboardingStatus] = React.useState<
    Record<string, OrganizationOnboardingStatus>
  >({})
  const [hasInitialized, setHasInitialized] = React.useState(false)
  const switchOrgMutation = useSwitchOrganization()
  const router = useRouter()
  const { toast } = useToast()

  // Track when orgs have been loaded at least once
  React.useEffect(() => {
    if (orgs.length > 0 && !hasInitialized) {
      setHasInitialized(true)
    }
  }, [orgs.length, hasInitialized])

  React.useEffect(() => {
    setActiveOrg(defaultOrg)
  }, [defaultOrg])

  // Fetch real onboarding status from database
  React.useEffect(() => {
    if (orgs.length === 0) return

    getOrganizationsOnboardingStatus()
      .then((result) => {
        if (result.success && result.data) {
          setOnboardingStatus(result.data)
        }
      })
      .catch((error) => {
        console.error(
          '[TeamSwitcher] Failed to fetch onboarding status:',
          error
        )
      })
  }, [orgs.length])

  // Helper to get real onboarding status
  const isOnboardingComplete = (orgId: string) => {
    // Use database status if available, otherwise default to true (don't block users)
    return onboardingStatus[orgId]?.onboardingComplete ?? true
  }

  // Helper to get organization logo from database
  const getOrgLogo = (orgId: string, fallbackLogo?: string | null) => {
    // Prefer logo from database query, fallback to Better Auth data
    return onboardingStatus[orgId]?.logo ?? fallbackLogo ?? null
  }

  const handleOrgSwitch = async (org: OrganizationWithRole) => {
    // Handle incomplete onboarding - switch to org and resume at scanning step
    if (!isOnboardingComplete(org.id)) {
      setIsSwitching(true)
      try {
        // 1. Switch to the incomplete org first
        const result = await switchOrganization(org.id)
        if (!result.success) {
          throw new Error(result.error || 'Failed to switch organization')
        }

        // 2. Also update backend default organization
        await switchOrgMutation.mutateAsync(org.id)

        // 3. Set localStorage for resume at 'scanning' step (leveraging existing recovery system)
        const savedStep = onboardingStatus[org.id]?.onboardingStep
        const resumeState = {
          version: '2.0',
          timestamp: Date.now(),
          organizationId: org.id,
          state: {
            currentStep: savedStep || 'scanning',
            organizationName: org.name,
            organizationCreated: true,
            organizationId: org.id,
          },
        }
        localStorage.setItem(
          'marginfront_onboarding_state',
          JSON.stringify(resumeState)
        )

        // 4. Full page redirect to onboarding
        window.location.href = '/quick-onboarding'
      } catch (error) {
        console.error('Failed to resume onboarding:', error)
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to resume onboarding. Please try again.',
        })
        setIsSwitching(false)
      }
      return
    }

    // Don't switch if already active
    if (org.isDefault) return

    setIsSwitching(true)
    setActiveOrg(org)

    try {
      // 1. Update Better Auth session via server action
      const result = await switchOrganization(org.id)

      if (!result.success) {
        throw new Error(result.error || 'Failed to switch organization')
      }

      // 2. Update backend default organization via API
      await switchOrgMutation.mutateAsync(org.id)

      // 3. Full page reload via / so the post-auth resolver picks the landing
      window.location.href = '/'
    } catch (error) {
      console.error('Failed to switch organization:', error)
      // Revert UI state
      setActiveOrg(defaultOrg)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to switch organization. Please try again.',
      })
    } finally {
      setIsSwitching(false)
    }
  }

  const handleAddTeam = () => {
    router.push('/quick-onboarding?new=true')
  }

  // Show loading skeleton while:
  // 1. Session is loading
  // 2. Organizations are being fetched
  // 3. User is authenticated but orgs haven't loaded yet
  const shouldShowSkeleton =
    isSessionLoading ||
    isOrgsLoading ||
    (isAuthenticated && !hasInitialized && orgs.length === 0)

  if (shouldShowSkeleton) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size='lg' disabled className='animate-pulse'>
            <div className='size-8 rounded-lg bg-sidebar-border' />
            <div className='grid flex-1 gap-1'>
              <div className='h-4 w-24 rounded bg-sidebar-border' />
              <div className='h-3 w-16 rounded bg-sidebar-border' />
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  // Only hide if we've confirmed there are no orgs after loading
  if (!activeOrg || (hasInitialized && orgs.length === 0)) return null

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size='lg'
              className='transition-colors data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
              disabled={isSwitching}
            >
              <OrgLogo
                logo={getOrgLogo(activeOrg.id, activeOrg.logo)}
                name={activeOrg.name}
                size='md'
              />
              <div className='grid flex-1 text-sm leading-tight'>
                <div className='flex min-w-0 items-center gap-1.5'>
                  <span className='truncate font-semibold'>
                    {activeOrg.name}
                  </span>
                </div>
                <span className='truncate text-xs text-muted-foreground'>
                  {activeOrg.isDefault ? 'Default' : activeOrg.role}
                </span>
              </div>
              <ChevronsUpDown className='ml-auto size-4 text-muted-foreground' />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className='w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg'
            align='start'
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className='text-xs text-muted-foreground'>
              Organizations
            </DropdownMenuLabel>
            <div className='max-h-[280px] overflow-y-auto'>
              {orgs.map((org) => {
                const isIncomplete = !isOnboardingComplete(org.id)
                return (
                  <DropdownMenuItem
                    key={org.id}
                    onClick={() => handleOrgSwitch(org)}
                    className={cn('gap-2 p-2', isIncomplete && 'opacity-60')}
                  >
                    <OrgLogo
                      logo={getOrgLogo(org.id, org.logo)}
                      name={org.name}
                      size='sm'
                    />
                    <div className='flex-1 truncate'>{org.name}</div>
                    {isIncomplete ? (
                      <DropdownMenuShortcut className='text-xs text-orange-500'>
                        Setup incomplete
                      </DropdownMenuShortcut>
                    ) : org.isDefault ? (
                      <DropdownMenuShortcut className='text-xs'>
                        Default
                      </DropdownMenuShortcut>
                    ) : null}
                  </DropdownMenuItem>
                )
              })}
            </div>
            <DropdownMenuSeparator />
            {canManageTeam && (
              <DropdownMenuItem asChild className='gap-2 p-2'>
                <Link href='/settings/team'>
                  <div className='flex size-6 items-center justify-center rounded-md border bg-background'>
                    <Users className='size-4' />
                  </div>
                  <div className='font-medium text-muted-foreground'>
                    Manage team & members
                  </div>
                </Link>
              </DropdownMenuItem>
            )}
            {canAddOrg && (
              <DropdownMenuItem className='gap-2 p-2' onClick={handleAddTeam}>
                <div className='flex size-6 items-center justify-center rounded-md border bg-background'>
                  <Plus className='size-4' />
                </div>
                <div className='font-medium text-muted-foreground'>
                  Add organization
                </div>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
