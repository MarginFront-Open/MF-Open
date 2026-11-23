import * as React from 'react'
import { cn } from '@/lib/utils'
import { Page, type BreadcrumbItem, type TabItem } from './page'

interface PageHeaderProps {
  breadcrumb?: BreadcrumbItem[]
  tabs?: TabItem[]
  actionButtons?: React.ReactNode
}

interface ContainerPageProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string
  headerProps?: PageHeaderProps
  children: React.ReactNode
}

export const ContainerPage = React.forwardRef<
  HTMLDivElement,
  ContainerPageProps
>(({ title, headerProps, className, children, ...props }, ref) => {
  return (
    <Page
      ref={ref}
      title={title}
      headerProps={headerProps}
      className={className}
      {...props}
    >
      <div className={cn('mx-auto w-full max-w-4xl')}>{children}</div>
    </Page>
  )
})
ContainerPage.displayName = 'ContainerPage'
