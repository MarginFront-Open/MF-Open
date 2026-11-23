'use client'

import { useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import {
  useInvitations,
  useResendInvitation,
  useCancelInvitation,
  type Invitation,
} from '@/services/organization-members-service'
import { Clock, Mail, MoreHorizontal, RefreshCw, X } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function PendingInvitations() {
  const { data: invitations, isLoading, isError, refetch } = useInvitations()
  const resendInvitation = useResendInvitation()
  const cancelInvitation = useCancelInvitation()
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const [selectedInvitation, setSelectedInvitation] =
    useState<Invitation | null>(null)

  const handleResend = async (invitationId: string) => {
    await resendInvitation.mutateAsync(invitationId)
  }

  const handleCancelClick = (invitation: Invitation) => {
    setSelectedInvitation(invitation)
    setCancelDialogOpen(true)
  }

  const handleCancelConfirm = async () => {
    if (selectedInvitation) {
      await cancelInvitation.mutateAsync(selectedInvitation.id)
      setCancelDialogOpen(false)
      setSelectedInvitation(null)
    }
  }

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'owner':
        return <Badge variant='default'>Owner</Badge>
      case 'admin':
        return <Badge variant='secondary'>Admin</Badge>
      default:
        return <Badge variant='outline'>Member</Badge>
    }
  }

  const formatExpiry = (expiresAt: string) => {
    const expiry = new Date(expiresAt)
    const now = new Date()
    if (expiry < now) {
      return <span className='text-destructive'>Expired</span>
    }
    return (
      <span className='text-muted-foreground'>
        Expires {formatDistanceToNow(expiry, { addSuffix: true })}
      </span>
    )
  }

  if (isLoading) {
    return <PendingInvitationsSkeleton />
  }

  if (isError) {
    return (
      <div className='flex flex-col items-center justify-center rounded-md border border-destructive bg-destructive/10 p-6 text-center text-destructive'>
        <p className='text-sm font-medium'>Failed to load invitations</p>
        <Button
          variant='outline'
          size='sm'
          onClick={() => refetch()}
          className='mt-3'
        >
          <RefreshCw className='mr-2 h-3 w-3' />
          Try Again
        </Button>
      </div>
    )
  }

  if (!invitations || invitations.length === 0) {
    return null
  }

  return (
    <Card className='transition-micro border-amber-200/50 border-border/50 bg-amber-50/30 shadow-sm dark:border-amber-900/30 dark:bg-amber-950/10'>
      <CardHeader className='space-y-1 pb-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Mail className='h-4 w-4 text-amber-600 dark:text-amber-500' />
            <CardTitle className='text-lg'>Pending Invitations</CardTitle>
            <Badge
              variant='secondary'
              className='ml-1 bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400'
            >
              {invitations.length}
            </Badge>
          </div>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => refetch()}
            className='h-8 px-2'
          >
            <RefreshCw className='h-3 w-3' />
          </Button>
        </div>
        <CardDescription>
          These users have been invited but haven&apos;t accepted yet.
        </CardDescription>
      </CardHeader>
      <CardContent className='pt-0'>
        <div className='rounded-lg border border-border/50 bg-card shadow-sm'>
          <Table>
            <TableHeader>
              <TableRow className='border-b border-border/50 hover:bg-transparent'>
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
                  Invited
                </TableHead>
                <TableHead className='text-right font-semibold text-foreground'>
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation, index) => (
                <TableRow
                  key={invitation.id}
                  className={`transition-micro hover:bg-muted/50 ${
                    index !== invitations.length - 1
                      ? 'border-b border-border/30'
                      : ''
                  }`}
                >
                  <TableCell className='font-medium'>
                    {invitation.email}
                  </TableCell>
                  <TableCell>{getRoleBadge(invitation.role)}</TableCell>
                  <TableCell>
                    <div className='flex items-center gap-1.5'>
                      <Clock className='h-3 w-3 text-muted-foreground' />
                      {formatExpiry(invitation.expiresAt)}
                    </div>
                  </TableCell>
                  <TableCell className='text-sm text-muted-foreground'>
                    {format(new Date(invitation.createdAt), 'MMM d, yyyy')}
                  </TableCell>
                  <TableCell className='text-right'>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant='ghost'
                          size='sm'
                          className='h-8 w-8 p-0'
                        >
                          <MoreHorizontal className='h-4 w-4' />
                          <span className='sr-only'>Open menu</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        <DropdownMenuItem
                          onClick={() => handleResend(invitation.id)}
                          disabled={resendInvitation.isPending}
                        >
                          <RefreshCw className='mr-2 h-4 w-4' />
                          Resend Invitation
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleCancelClick(invitation)}
                          className='text-destructive focus:text-destructive'
                        >
                          <X className='mr-2 h-4 w-4' />
                          Cancel Invitation
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel Invitation</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to cancel the invitation to{' '}
                <strong>{selectedInvitation?.email}</strong>? They will no
                longer be able to join using this invitation link.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep Invitation</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleCancelConfirm}
                className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
              >
                {cancelInvitation.isPending
                  ? 'Canceling...'
                  : 'Cancel Invitation'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

function PendingInvitationsSkeleton() {
  return (
    <Card className='border-border/50 shadow-sm'>
      <CardHeader className='space-y-1 pb-4'>
        <div className='flex items-center gap-2'>
          <Skeleton className='h-4 w-4' />
          <Skeleton className='h-5 w-36' />
        </div>
        <Skeleton className='h-4 w-64' />
      </CardHeader>
      <CardContent className='pt-0'>
        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invited</TableHead>
                <TableHead className='text-right'>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array(2)
                .fill(0)
                .map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className='h-4 w-[180px]' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-[60px]' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-[100px]' />
                    </TableCell>
                    <TableCell>
                      <Skeleton className='h-4 w-[80px]' />
                    </TableCell>
                    <TableCell className='text-right'>
                      <Skeleton className='ml-auto h-8 w-8' />
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
