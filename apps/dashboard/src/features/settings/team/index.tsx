'use client'

import { IconLock } from '@tabler/icons-react'
import { isAdmin } from '@/lib/permissions'
import { useCurrentOrganization } from '@/hooks/use-auth'
import { Badge } from '@/components/ui/badge'
import { OrganizationMembersPage } from '@/features/organization/members/organization-members-page'

export default function TeamSettings() {
  const { organization: currentOrg, isLoading: isOrgLoading } =
    useCurrentOrganization()
  const userRole = currentOrg?.role
  const hasAdminAccess = isAdmin(userRole)

  return (
    <div className='max-w-5xl space-y-6'>
      <div>
        <div className='flex items-center gap-3'>
          <h2 className='section-header mt-0'>Team</h2>
          {hasAdminAccess && (
            <Badge
              variant='secondary'
              className='border-primary/20 bg-primary/10 text-primary'
            >
              Admin Access
            </Badge>
          )}
        </div>
        <p className='text-description'>
          Manage your team members and their roles.
        </p>
      </div>

      {/* Guarded on !isOrgLoading so the banner doesn't flash on hard refresh before
          the session resolves (role starts undefined = treated as non-admin). */}
      {!isOrgLoading && !hasAdminAccess && (
        <div className='rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950'>
          <div className='flex items-start gap-3'>
            <IconLock className='mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700 dark:text-amber-400' />
            <div>
              <p className='text-sm font-medium text-amber-900 dark:text-amber-100'>
                View-Only Access
              </p>
              <p className='mt-1 text-xs text-amber-700 dark:text-amber-300'>
                You don&apos;t have permission to manage team members. Contact
                your organization admin for access.
              </p>
            </div>
          </div>
        </div>
      )}

      <OrganizationMembersPage />
    </div>
  )
}
