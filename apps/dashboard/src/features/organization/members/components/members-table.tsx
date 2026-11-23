import { useState } from 'react'
import { format } from 'date-fns'
import { useOrganizationMembers } from '@/services/organization-members-service'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { MemberRoleSelect } from './member-role-select'
import { RemoveMemberButton } from './remove-member-button'

export function MembersTable() {
  const [searchQuery, setSearchQuery] = useState('')
  const {
    data: members,
    isLoading,
    isError,
    refetch,
  } = useOrganizationMembers()

  const filteredMembers = members?.filter((member) => {
    if (!searchQuery) return true
    const query = searchQuery.toLowerCase()
    return (
      member.user.name?.toLowerCase().includes(query) ||
      member.user.email.toLowerCase().includes(query) ||
      member.role.toLowerCase().includes(query)
    )
  })

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant='success'>Active</Badge>
      case 'invited':
        return <Badge variant='warning'>Invited</Badge>
      case 'removed':
        return <Badge variant='destructive'>Removed</Badge>
      default:
        return <Badge variant='secondary'>{status}</Badge>
    }
  }

  const formatDate = (dateString: string) => {
    try {
      return format(new Date(dateString), 'MMM d, yyyy')
    } catch (_e) {
      return dateString
    }
  }

  if (isLoading) {
    return <MembersTableSkeleton />
  }

  if (isError) {
    return (
      <div className='my-8 flex flex-col items-center justify-center rounded-md border border-destructive bg-destructive/10 p-8 text-center text-destructive'>
        <p className='text-lg font-medium'>Failed to load members</p>
        <Button variant='outline' onClick={() => refetch()} className='mt-4'>
          <RefreshCw className='mr-2 h-4 w-4' />
          Try Again
        </Button>
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      <div className='flex items-center justify-between gap-4'>
        <Input
          placeholder='Search members...'
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className='focus-ring transition-standard max-w-sm'
        />
        <Button
          variant='outline'
          size='sm'
          onClick={() => refetch()}
          className='transition-micro'
        >
          <RefreshCw className='mr-2 h-4 w-4' />
          Refresh
        </Button>
      </div>

      <div className='rounded-lg border border-border/50 bg-card shadow-sm'>
        <Table className='w-full'>
          <TableHeader>
            <TableRow className='border-b border-border/50 hover:bg-transparent'>
              <TableHead className='font-semibold text-foreground'>
                Name
              </TableHead>
              <TableHead className='font-semibold text-foreground'>
                Email
              </TableHead>
              <TableHead className='font-semibold text-foreground'>
                Role
              </TableHead>
              <TableHead className='font-semibold text-foreground'>
                Status
              </TableHead>
              <TableHead className='font-semibold text-foreground'>
                Joined
              </TableHead>
              <TableHead className='text-right font-semibold text-foreground'>
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredMembers && filteredMembers.length > 0 ? (
              filteredMembers.map((member, index) => (
                <TableRow
                  key={member.id}
                  className={`transition-micro hover:bg-muted/50 ${
                    index !== filteredMembers.length - 1
                      ? 'border-b border-border/30'
                      : ''
                  }`}
                >
                  <TableCell className='font-medium'>
                    {member.user.name || '—'}
                  </TableCell>
                  <TableCell className='text-sm text-muted-foreground'>
                    {member.user.email}
                  </TableCell>
                  <TableCell>
                    <MemberRoleSelect member={member} />
                  </TableCell>
                  <TableCell>{getStatusBadge('active')}</TableCell>
                  <TableCell className='font-tabular text-sm'>
                    {formatDate(member.createdAt)}
                  </TableCell>
                  <TableCell className='text-right'>
                    <div className='flex justify-end space-x-2'>
                      <RemoveMemberButton member={member} />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className='h-32 text-center text-muted-foreground'
                >
                  <div className='flex flex-col items-center justify-center space-y-2'>
                    <p className='text-sm'>
                      {searchQuery
                        ? 'No members match your search.'
                        : 'No team members yet.'}
                    </p>
                    {!searchQuery && (
                      <p className='text-xs text-muted-foreground/70'>
                        Invite members to get started
                      </p>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function MembersTableSkeleton() {
  return (
    <div className='space-y-4'>
      <div className='flex items-center justify-between'>
        <Skeleton className='h-10 w-[300px]' />
        <Skeleton className='h-10 w-[100px]' />
      </div>
      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined At</TableHead>
              <TableHead className='text-right'>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array(5)
              .fill(0)
              .map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Skeleton className='h-5 w-[120px]' />
                  </TableCell>
                  <TableCell>
                    <Skeleton className='h-5 w-[180px]' />
                  </TableCell>
                  <TableCell>
                    <Skeleton className='h-5 w-[80px]' />
                  </TableCell>
                  <TableCell>
                    <Skeleton className='h-5 w-[60px]' />
                  </TableCell>
                  <TableCell>
                    <Skeleton className='h-5 w-[100px]' />
                  </TableCell>
                  <TableCell className='text-right'>
                    <div className='flex justify-end'>
                      <Skeleton className='h-9 w-9' />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
