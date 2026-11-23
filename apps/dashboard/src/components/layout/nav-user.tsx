'use client'

import {
  ChevronsUpDown,
  LogOut,
  Sun,
  Moon,
  Monitor,
  Check,
  Settings,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTheme } from '@/context/theme-context'
import { useAuth } from '@/hooks/use-auth'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'

export function NavUser() {
  const { isMobile } = useSidebar()
  const { user: userData, isLoading, logout } = useAuth()
  const router = useRouter()
  const { theme, setTheme } = useTheme()

  // While the session is resolving, show a neutral loading skeleton instead
  // of any placeholder identity text.
  if (isLoading || !userData) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <div className='flex items-center gap-2 rounded-md p-2'>
            <div className='grid flex-1 gap-1.5'>
              <Skeleton variant='text' className='h-3.5 w-24' />
              <Skeleton variant='text' className='h-3 w-32' />
            </div>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  const displayUser = {
    name: userData.email?.split('@')[0] || '',
    email: userData.email || '',
  }

  const handleLogout = async () => {
    try {
      await logout()
    } catch (error) {
      console.error('Logout error:', error)
      router.push('/sign-in')
    }
  }

  const themes = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
  ]

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size='lg'
              className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
            >
              <div className='grid flex-1 text-left text-sm leading-tight'>
                <span className='truncate font-semibold'>
                  {displayUser.name}
                </span>
                <span className='truncate text-xs'>{displayUser.email}</span>
              </div>
              <ChevronsUpDown className='ml-auto size-4' />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className='w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg'
            side={isMobile ? 'bottom' : 'right'}
            align='end'
            sideOffset={4}
          >
            <DropdownMenuLabel className='p-0 font-normal'>
              <div className='flex items-center gap-2 px-2 py-2 text-left text-sm'>
                <div className='grid flex-1 text-left text-sm leading-tight'>
                  <span className='truncate font-semibold'>
                    {displayUser.name}
                  </span>
                  <span className='truncate text-xs text-muted-foreground'>
                    {displayUser.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {/* The Settings page's own tab bar (src/features/settings) is
              the single correctly-gated settings surface: one link in, tabs
              handle the rest. */}
              <DropdownMenuItem asChild>
                <Link href='/settings/profile' className='gap-2'>
                  <Settings className='size-4' />
                  Settings
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className='px-2 py-1.5 text-xs font-semibold text-muted-foreground'>
              Theme
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {themes.map((t) => (
                <DropdownMenuItem
                  key={t.value}
                  onClick={() =>
                    setTheme(t.value as 'light' | 'dark' | 'system')
                  }
                  className='gap-2'
                >
                  <t.icon className='size-4' />
                  <span className='flex-1'>{t.label}</span>
                  {theme === t.value && <Check className='ml-auto size-4' />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout} className='gap-2'>
              <LogOut className='size-4' />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
