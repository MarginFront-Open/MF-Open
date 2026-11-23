'use client'

import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { TopNav } from '@/components/layout/top-nav'

export interface BreadcrumbItem {
  name: string
  href?: string
}

export interface TabItem {
  title: string
  href: string
  isActive: boolean
  disabled?: boolean
}

interface PageHeaderProps extends React.HTMLAttributes<HTMLElement> {
  title: string
  breadcrumb?: BreadcrumbItem[]
  tabs?: TabItem[]
  actionButtons?: React.ReactNode
}

export const PageHeader = React.forwardRef<HTMLElement, PageHeaderProps>(
  ({ title, breadcrumb, tabs, actionButtons, className, ...props }, ref) => {
    // Only show breadcrumbs if there are 2+ items (showing a path)
    const showBreadcrumbs = breadcrumb && breadcrumb.length > 1

    return (
      <header
        ref={ref}
        className={cn(
          'flex-shrink-0 border-b border-border/40 bg-background px-6 py-4',
          className
        )}
        {...props}
      >
        <div className='flex items-center justify-between gap-4'>
          <div className='min-w-0 flex-1'>
            {showBreadcrumbs && (
              <nav className='mb-2 flex items-center space-x-1 text-sm text-muted-foreground'>
                {breadcrumb.map((item, index) => (
                  <React.Fragment key={index}>
                    {item.href && typeof item.href === 'string' ? (
                      <Link
                        href={item.href}
                        className='transition-colors hover:text-foreground'
                      >
                        {item.name}
                      </Link>
                    ) : (
                      <span className='font-medium text-foreground'>
                        {item.name}
                      </span>
                    )}
                    {index < breadcrumb.length - 1 && (
                      <ChevronRight className='h-4 w-4 flex-shrink-0' />
                    )}
                  </React.Fragment>
                ))}
              </nav>
            )}
            <div className='flex items-center gap-6'>
              <h1 className='truncate text-2xl font-semibold tracking-tight'>
                {title}
              </h1>
              {tabs && tabs.length > 0 && <TopNav links={tabs} />}
            </div>
          </div>
          {actionButtons && (
            <div className='flex flex-shrink-0 items-center gap-2'>
              {actionButtons}
            </div>
          )}
        </div>
      </header>
    )
  }
)
PageHeader.displayName = 'PageHeader'
