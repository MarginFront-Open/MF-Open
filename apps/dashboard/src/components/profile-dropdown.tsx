'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/hooks/use-auth'
import { useToast } from '@/hooks/use-toast'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function ProfileDropdown() {
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const { toast } = useToast()
  const { user, getOrg, logout } = useAuth()
  const org = getOrg()

  // Function to get organization initials
  const getOrgInitials = (orgName: string | undefined) => {
    if (!orgName) return 'UN'
    // Split by spaces and get first letter of each word
    return orgName
      .split(' ')
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .substring(0, 2)
  }

  const handleLogout = async () => {
    try {
      setIsLoggingOut(true)

      // Show success toast
      toast({
        title: 'Logged out successfully',
        description: 'You have been logged out of your account',
      })

      // Use Better Auth logout
      await logout()
    } catch (error) {
      console.error('Logout process error:', error)

      // Show error toast
      toast({
        variant: 'destructive',
        title: 'Logout failed',
        description: 'An error occurred while logging out. Please try again.',
      })
    } finally {
      setIsLoggingOut(false)
    }
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant='ghost'
          className='relative mr-2 h-8 w-8 flex-shrink-0 rounded-full'
        >
          <Avatar className='h-8 w-8'>
            <AvatarImage src='/avatars/01.png' alt='Organization avatar' />
            <AvatarFallback>{getOrgInitials(org?.name)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className='w-56'
        align='end'
        alignOffset={-8}
        sideOffset={8}
      >
        <DropdownMenuLabel className='font-normal'>
          <div className='flex flex-col space-y-1'>
            <p className='truncate text-sm font-medium leading-none'>
              {org?.name || 'Organization'}
            </p>
            <p className='truncate text-xs leading-none text-muted-foreground'>
              {user?.email || 'No email'}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href='/settings'>
              Profile
              <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href='/settings'>
              Billing
              <DropdownMenuShortcut>⌘B</DropdownMenuShortcut>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href='/settings'>
              Settings
              <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem>New Team</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout} disabled={isLoggingOut}>
          {isLoggingOut ? 'Logging out...' : 'Log out'}
          <DropdownMenuShortcut>⇧⌘Q</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
