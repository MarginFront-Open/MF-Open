'use client'

import * as React from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useLayout } from '@/context/layout-context'

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

interface PageHeaderProps {
  breadcrumb?: BreadcrumbItem[]
  tabs?: TabItem[]
  actionButtons?: React.ReactNode
}

interface PageProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string
  // One-sentence summary shown below the page title in muted text
  description?: string
  scrollable?: boolean
  withPadding?: boolean
  headerProps?: PageHeaderProps
  children: React.ReactNode
}

export const Page = React.forwardRef<HTMLDivElement, PageProps>(
  (
    {
      title,
      description,
      scrollable = true,
      withPadding = true,
      headerProps,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const { updateOptions } = useLayout()

    // Push breadcrumbs into the global header (SmartBreadcrumbs reads
    // options.breadcrumbs; header.tsx renders it). No header element renders
    // pageTitle: the visible title is the in-body <h1> below, matching the
    // PageShell command pages.
    React.useEffect(() => {
      const breadcrumbs =
        headerProps?.breadcrumb?.map((item, index) => ({
          title: item.name,
          href: item.href,
          isCurrent: index === (headerProps.breadcrumb?.length || 0) - 1,
        })) || []

      updateOptions({
        pageTitle: title,
        breadcrumbs: breadcrumbs.length > 0 ? breadcrumbs : undefined,
      })
    }, [title, headerProps?.breadcrumb, updateOptions])

    const hasTabs = Boolean(headerProps?.tabs && headerProps.tabs.length > 0)

    return (
      <div
        ref={ref}
        className={cn(
          'flex h-full flex-col overflow-hidden bg-mf-bg',
          className
        )}
        {...props}
      >
        {/* Title bar: in-body <h1> (PageShell command-page style) + optional actions/tabs.
            Skipped entirely when there is nothing to show — an empty-title page
            with no tabs/actions (e.g. invoice detail, which renders its own
            invoice-number heading in the body) must not get a blank bar or an
            empty <h1>. */}
        {(title || description || hasTabs || headerProps?.actionButtons) && (
          <div
            className={cn(
              'flex-shrink-0 border-b border-mf-bd bg-mf-bg px-[22px] pt-5',
              hasTabs ? 'pb-0' : 'pb-4'
            )}
          >
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div className='min-w-0'>
                {title && (
                  <h1 className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
                    {title}
                  </h1>
                )}
                {description && (
                  <p className='mt-1 text-[11.5px] text-mf-tx2'>
                    {description}
                  </p>
                )}
              </div>
              {headerProps?.actionButtons && (
                <div className='flex flex-shrink-0 flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3'>
                  {headerProps.actionButtons}
                </div>
              )}
            </div>

            {hasTabs && (
              <nav
                className='scrollbar-hide -mb-px mt-3 flex gap-4 overflow-x-auto md:gap-6'
                role='tablist'
              >
                {headerProps?.tabs?.map((tab) => (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={cn(
                      'inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-semibold transition-colors duration-200',
                      tab.isActive
                        ? 'border-mf-accent text-mf-accent'
                        : 'border-transparent text-mf-tx2 hover:border-mf-bd hover:text-mf-tx',
                      tab.disabled && 'pointer-events-none opacity-50'
                    )}
                    aria-current={tab.isActive ? 'page' : undefined}
                    aria-disabled={tab.disabled}
                  >
                    {tab.title}
                  </Link>
                ))}
              </nav>
            )}
          </div>
        )}

        {/* Main Content */}
        <div
          className={cn(
            'min-h-0 flex-1',
            scrollable && 'overflow-y-auto',
            withPadding && 'px-[22px] py-5'
          )}
        >
          {children}
        </div>
      </div>
    )
  }
)
Page.displayName = 'Page'
