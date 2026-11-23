'use client'

import { IconLogout } from '@tabler/icons-react'
import { useLogout } from '@/services/auth-service'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function LogoutButton() {
  const router = useRouter()
  const logout = useLogout()

  const handleLogout = async () => {
    try {
      // Call logout API using the hook
      await logout.mutateAsync()

      // Redirect to login
      router.push('/sign-in')
    } catch (error) {
      console.error('Logout error:', error)
      router.push('/sign-in')
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='ghost'
          className='h-8 w-8 p-0'
          aria-label='Logout Options'
        >
          <IconLogout className='h-4 w-4' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuItem onClick={handleLogout}>Logout</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
