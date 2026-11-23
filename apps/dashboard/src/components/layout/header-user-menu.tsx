'use client'

import {
  BadgeCheck,
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function HeaderUserMenu() {
  const { user: userData, logout } = useAuth()
  const router = useRouter()
  const { theme, setTheme } = useTheme()

  // Fallback user data
  const displayUser = {
    name: userData?.email?.split('@')[0] || 'User',
    email: userData?.email || 'user@example.com',
    avatar: '', // Can add avatar URL from userData if available
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          className='relative h-9 w-9 rounded-full transition-all duration-200 hover:bg-primary/10 hover:ring-2 hover:ring-primary/20 active:scale-95'
        >
          <Avatar className='h-8 w-8 ring-2 ring-primary/10 transition-all duration-200 hover:ring-primary/30'>
            <AvatarImage src={displayUser.avatar} alt={displayUser.name} />
            <AvatarFallback className='bg-primary/10 text-sm font-bold text-primary'>
              {displayUser.name.substring(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='end'
        className='w-56 duration-200 animate-in fade-in-0 zoom-in-95'
        sideOffset={8}
      >
        <DropdownMenuLabel className='p-0 font-normal'>
          <div className='flex items-center gap-2 px-2 py-2 text-left text-sm'>
            <Avatar className='h-8 w-8 ring-2 ring-primary/10'>
              <AvatarImage src={displayUser.avatar} alt={displayUser.name} />
              <AvatarFallback className='bg-primary/10 text-sm font-bold text-primary'>
                {displayUser.name.substring(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className='grid flex-1 text-left text-sm leading-tight'>
              <span className='truncate font-bold text-foreground'>
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
          <DropdownMenuItem asChild>
            <Link href='/settings/team' className='gap-2'>
              <BadgeCheck className='h-4 w-4' />
              Account
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href='/settings' className='gap-2'>
              <Settings className='h-4 w-4' />
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
              onClick={() => setTheme(t.value as 'light' | 'dark' | 'system')}
              className='gap-2'
            >
              <t.icon className='h-4 w-4' />
              <span className='flex-1'>{t.label}</span>
              {theme === t.value && <Check className='ml-auto h-4 w-4' />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          className='gap-2 text-destructive focus:text-destructive'
        >
          <LogOut className='h-4 w-4' />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
