import { useState } from 'react'
import { useRemoveMember } from '@/services/organization-members-service'
import { OrganizationMember } from '@/services/organization-members-service'
import { Trash2 } from 'lucide-react'
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
import { Button } from '@/components/ui/button'

interface RemoveMemberButtonProps {
  member: OrganizationMember
  variant?:
    | 'default'
    | 'destructive'
    | 'outline'
    | 'secondary'
    | 'ghost'
    | 'link'
}

export function RemoveMemberButton({
  member,
  variant = 'ghost',
}: RemoveMemberButtonProps) {
  const [open, setOpen] = useState(false)
  const removeMember = useRemoveMember()
  const { currentUser } = useAuth()

  const isSelf = currentUser?.user?.id === member.user.id
  const isOwner = currentUser?.user?.role === 'owner'
  const canRemove = isOwner && !isSelf

  const handleRemove = async () => {
    await removeMember.mutateAsync(member.id)
    setOpen(false)
  }

  if (!canRemove) return null

  return (
    <>
      <Button
        variant={variant}
        size='sm'
        onClick={() => setOpen(true)}
        disabled={removeMember.isPending}
      >
        <Trash2 className='h-4 w-4' />
        <span className='sr-only'>Remove</span>
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove {member.user.name} from your
              organization? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className='bg-red-500 hover:bg-red-600'
            >
              {removeMember.isPending ? 'Removing...' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
