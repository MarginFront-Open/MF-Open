import { useState } from 'react'
import { useUpdateMemberRole } from '@/services/organization-members-service'
import { OrganizationMember } from '@/services/organization-members-service'
import { useAuth } from '@/hooks/use-auth'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface MemberRoleSelectProps {
  member: OrganizationMember
}

export function MemberRoleSelect({ member }: MemberRoleSelectProps) {
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [pendingRole, setPendingRole] = useState<string | null>(null)
  const updateRole = useUpdateMemberRole()
  const { currentUser } = useAuth()

  const isSelf = currentUser?.user?.id === member.user.id
  const isOwner = currentUser?.user?.role === 'owner'
  const canEditRole = isOwner && !isSelf

  const handleRoleChange = (role: string) => {
    if (role === member.role) return

    setPendingRole(role)
    setShowConfirmation(true)
  }

  const confirmRoleChange = async () => {
    if (!pendingRole) return

    await updateRole.mutateAsync({
      memberId: member.id,
      // finance is view-only, developer is the build/operations seat,
      // legal is the matter seat.
      role: pendingRole as
        | 'owner'
        | 'member'
        | 'admin'
        | 'finance'
        | 'developer'
        | 'legal',
    })

    setShowConfirmation(false)
    setPendingRole(null)
  }

  const cancelRoleChange = () => {
    setShowConfirmation(false)
    setPendingRole(null)
  }

  return (
    <>
      <Select
        value={member.role}
        onValueChange={handleRoleChange}
        disabled={!canEditRole || updateRole.isPending}
      >
        <SelectTrigger className='w-[130px]'>
          <SelectValue placeholder='Select a role' />
        </SelectTrigger>
        {/* Role names only: descriptions don't fit a 130px select. */}
        <SelectContent>
          <SelectItem value='member'>Member</SelectItem>
          <SelectItem value='finance'>Finance</SelectItem>
          <SelectItem value='developer'>Developer</SelectItem>
          <SelectItem value='legal'>Legal</SelectItem>
          <SelectItem value='admin'>Admin</SelectItem>
          <SelectItem value='owner'>Owner</SelectItem>
        </SelectContent>
      </Select>

      <AlertDialog open={showConfirmation} onOpenChange={setShowConfirmation}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change Role</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to change the role of {member.user.name}{' '}
              from {member.role} to {pendingRole}?
              {pendingRole === 'owner' && (
                <p className='mt-2 text-red-500'>
                  Warning: Making this user an owner will give them full
                  administrative access to your organization.
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelRoleChange}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRoleChange}
              className={
                pendingRole === 'owner' ? 'bg-red-500 hover:bg-red-600' : ''
              }
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
