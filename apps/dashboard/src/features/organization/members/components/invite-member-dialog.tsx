// @ts-nocheck
import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useInviteMember } from '@/services/organization-members-service'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const formSchema = z.object({
  email: z.string().email({ message: 'Please enter a valid email' }),
  // Every role is invitable by email. Better Auth accepts finance, developer
  // and legal because app/lib/permissions.ts registers them with the
  // organization plugin used by authClient.organization.inviteMember().
  // ba_invitation.role and ba_member.role are free-form text columns; the
  // accepted invite carries the chosen role onto the new member.
  role: z.enum(['owner', 'member', 'admin', 'finance', 'developer', 'legal'], {
    required_error: 'Please select a role',
  }),
  message: z.string().optional(),
})

interface InviteMemberDialogProps {
  buttonVariant?:
    | 'default'
    | 'outline'
    | 'secondary'
    | 'destructive'
    | 'ghost'
    | 'link'
  buttonSize?: 'default' | 'sm' | 'lg' | 'icon'
  className?: string
}

export function InviteMemberDialog({
  buttonVariant = 'default',
  buttonSize = 'default',
  className,
}: InviteMemberDialogProps) {
  const [open, setOpen] = useState(false)
  const inviteMember = useInviteMember()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: '',
      role: 'member',
      message: '',
    },
  })

  const onSubmit = async (data: z.infer<typeof formSchema>) => {
    await inviteMember.mutateAsync(data)
    form.reset()
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={buttonVariant}
          size={buttonSize}
          className={`transition-micro ${className}`}
        >
          <Mail className='mr-2 h-4 w-4' />
          Invite Member
        </Button>
      </DialogTrigger>
      <DialogContent className='sm:max-w-[480px]'>
        <DialogHeader className='space-y-2'>
          <DialogTitle className='text-xl'>Invite Team Member</DialogTitle>
          <DialogDescription className='text-sm'>
            Send an invitation email to join your organization. They&apos;ll
            receive a secure link to accept.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className='space-y-5 pt-2'
          >
            <FormField
              control={form.control}
              name='email'
              render={({ field }) => (
                <FormItem>
                  <FormLabel className='text-sm font-medium'>
                    Email Address
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder='member@example.com'
                      {...field}
                      className='focus-ring transition-standard'
                    />
                  </FormControl>
                  <FormMessage className='text-xs' />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='role'
              render={({ field }) => (
                <FormItem>
                  <FormLabel className='text-sm font-medium'>Role</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className='focus-ring transition-standard'>
                        <SelectValue placeholder='Select a role' />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value='member' className='transition-micro'>
                        <div className='flex flex-col items-start'>
                          <span className='font-medium'>Member</span>
                          <span className='text-xs text-muted-foreground'>
                            Standard team access
                          </span>
                        </div>
                      </SelectItem>
                      <SelectItem value='finance' className='transition-micro'>
                        <div className='flex flex-col items-start'>
                          <span className='font-medium'>Finance</span>
                          <span className='text-xs text-muted-foreground'>
                            Manages the books and billing
                          </span>
                        </div>
                      </SelectItem>
                      <SelectItem
                        value='developer'
                        className='transition-micro'
                      >
                        <div className='flex flex-col items-start'>
                          <span className='font-medium'>Developer</span>
                          <span className='text-xs text-muted-foreground'>
                            Manages API keys, agents, and integrations
                          </span>
                        </div>
                      </SelectItem>
                      <SelectItem value='legal' className='transition-micro'>
                        <div className='flex flex-col items-start'>
                          <span className='font-medium'>Legal</span>
                          <span className='text-xs text-muted-foreground'>
                            Manages matters and the AI cost audit trail
                          </span>
                        </div>
                      </SelectItem>
                      <SelectItem value='admin' className='transition-micro'>
                        <div className='flex flex-col items-start'>
                          <span className='font-medium'>Admin</span>
                          <span className='text-xs text-muted-foreground'>
                            Can manage team and settings
                          </span>
                        </div>
                      </SelectItem>
                      <SelectItem value='owner' className='transition-micro'>
                        <div className='flex flex-col items-start'>
                          <span className='font-medium'>Owner</span>
                          <span className='text-xs text-muted-foreground'>
                            Full access and billing control
                          </span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className='text-xs' />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='message'
              render={({ field }) => (
                <FormItem>
                  <FormLabel className='text-sm font-medium'>
                    Personal Message{' '}
                    <span className='text-muted-foreground'>(Optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder='Add a personal message to the invitation email...'
                      className='focus-ring transition-standard resize-none'
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className='text-xs' />
                </FormItem>
              )}
            />
            <DialogFooter className='gap-2 pt-2 sm:gap-0'>
              <Button
                type='button'
                variant='outline'
                onClick={() => setOpen(false)}
                className='transition-micro'
              >
                Cancel
              </Button>
              <Button
                type='submit'
                disabled={inviteMember.isPending}
                className='transition-micro'
              >
                {inviteMember.isPending ? 'Sending...' : 'Send Invitation'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
