'use client'

import { IconMenu } from '@tabler/icons-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface TopNavProps extends React.HTMLAttributes<HTMLElement> {
  links: {
    title: string
    href: string
    isActive: boolean
    disabled?: boolean
  }[]
}

export function TopNav({ className, links, ...props }: TopNavProps) {
  return (
    <>
      <div className='md:hidden'>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size='icon' variant='outline'>
              <IconMenu />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side='bottom' align='start'>
            {links.map(({ title, href, isActive, disabled: _disabled }) => {
              const linkHref = typeof href === 'string' ? href : '#'
              return (
                <DropdownMenuItem key={`${title}-${linkHref}`} asChild>
                  <Link
                    href={linkHref}
                    className={!isActive ? 'text-muted-foreground' : ''}
                  >
                    {title}
                  </Link>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav
        className={cn(
          'hidden items-center space-x-1 md:flex lg:space-x-2',
          className
        )}
        {...props}
      >
        {links.map(({ title, href, isActive, disabled }) => {
          const linkHref = typeof href === 'string' ? href : '#'
          return (
            <Link
              key={`${title}-${linkHref}`}
              href={linkHref}
              className={cn(
                // Brand Navigation Styling
                'relative rounded-md px-4 py-2 text-sm font-semibold',
                'transition-all duration-200 ease-out',
                'hover:bg-primary/10 hover:text-primary',
                isActive
                  ? 'bg-primary/10 font-bold text-primary'
                  : 'text-muted-foreground hover:text-foreground',
                disabled && 'pointer-events-none cursor-not-allowed opacity-50',
                // Active indicator
                isActive &&
                  'after:absolute after:bottom-0 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary'
              )}
            >
              {title}
            </Link>
          )
        })}
      </nav>
    </>
  )
}
