'use client'

import { Fragment } from 'react'
import Link from 'next/link'
import { useLayout } from '@/context/layout-context'
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

export function SmartBreadcrumbs() {
  const { options } = useLayout()

  // Use breadcrumbs from layout context if available
  if (options.breadcrumbs && options.breadcrumbs.length > 0) {
    return (
      <Breadcrumb className='overflow-hidden'>
        <BreadcrumbList className='flex-nowrap items-center overflow-hidden text-sm'>
          {options.breadcrumbs.map((crumb, index) => (
            <Fragment key={`${crumb.title}-${index}`}>
              {index > 0 && (
                <BreadcrumbSeparator className='flex-shrink-0'>
                  <span className='mx-0.5 text-muted-foreground/60'>/</span>
                </BreadcrumbSeparator>
              )}
              {crumb.isCurrent ? (
                <BreadcrumbItem className='min-w-0'>
                  <BreadcrumbPage className='flex items-center font-semibold text-primary'>
                    {crumb.title}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              ) : (
                <BreadcrumbItem className='min-w-0'>
                  <BreadcrumbLink asChild>
                    <Link
                      href={
                        typeof crumb.href === 'string' && crumb.href
                          ? crumb.href
                          : '#'
                      }
                      className='flex items-center font-medium text-muted-foreground transition-colors hover:text-primary'
                    >
                      {crumb.title}
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
              )}
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    )
  }

  // Breadcrumbs come only from the layout context; with none, render nothing.
  return null
}
