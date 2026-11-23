'use client'

import { useCurrentOrganization } from '@/hooks/use-auth'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { InviteMemberDialog } from './components/invite-member-dialog'
import { MembersTable } from './components/members-table'
import { PendingInvitations } from './components/pending-invitations'

export function OrganizationMembersPage() {
  const { organization: org } = useCurrentOrganization()

  return (
    <div className='w-full space-y-6'>
      <div className='flex items-center justify-between'>
        <div className='space-y-1'>
          <h2 className='text-2xl font-semibold tracking-tight'>
            {org?.name || 'Organization'} Team
          </h2>
          <p className='text-sm text-muted-foreground'>
            Manage team members, roles, and invitations.
          </p>
        </div>
        <div className='flex gap-3'>
          <InviteMemberDialog />
        </div>
      </div>

      <PendingInvitations />

      <Card className='transition-micro hover-lift border-border/50 shadow-sm'>
        <CardHeader className='space-y-1 pb-4'>
          <CardTitle className='text-lg'>Active Members</CardTitle>
          <CardDescription>
            View and manage all active members in your organization.
          </CardDescription>
        </CardHeader>
        <CardContent className='pt-0'>
          <MembersTable />
        </CardContent>
      </Card>
    </div>
  )
}
