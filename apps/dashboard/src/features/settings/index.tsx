'use client'

import { useMemo, Suspense } from 'react'
import {
  IconUser,
  IconUsers,
  IconPlug,
  IconCreditCard,
} from '@tabler/icons-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { getVisibleSettingsTabKeys } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { useCurrentOrganization } from '@/hooks/use-auth'
import { Page } from '@/components/layouts/page'
import { Skeleton } from '@/components/ui/skeleton'

export default function Settings({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const currentPath = pathname
  const { organization: currentOrg } = useCurrentOrganization()
  const userRole = currentOrg?.role

  const isProfilePage = currentPath === '/settings'

  const visibleTabs = useMemo(() => {
    const visibleKeys = new Set(
      getVisibleSettingsTabKeys(
        settingsTabs.map((tab) => tab.key),
        userRole
      )
    )
    return settingsTabs.filter((tab) => visibleKeys.has(tab.key))
  }, [userRole])

  if (isProfilePage) {
    return (
      <Page
        title='Edit Profile'
        headerProps={{
          breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Edit Profile' }],
        }}
      >
        {children}
      </Page>
    )
  }

  return (
    <Page
      title='Settings'
      headerProps={{
        breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Settings' }],
      }}
    >
      <div className='flex flex-col gap-6'>
        <div className='border-b border-border/50'>
          <nav className='flex gap-6' aria-label='Settings sections'>
            {visibleTabs.map((tab) => {
              const isActive =
                currentPath === tab.href ||
                (tab.href !== '/settings' && currentPath.startsWith(tab.href))

              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={cn(
                    'transition-micro flex items-center gap-2 border-b-2 pb-3 text-sm font-medium',
                    isActive
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
                  )}
                >
                  {tab.icon}
                  {tab.title}
                </Link>
              )
            })}
          </nav>
        </div>

        <div className='flex-1'>
          <Suspense
            fallback={
              <div className='space-y-4'>
                <Skeleton className='h-8 w-48' />
                <Skeleton className='h-4 w-96' />
                <Skeleton className='h-64 w-full' />
              </div>
            }
          >
            {children}
          </Suspense>
        </div>
      </div>
    </Page>
  )
}

const settingsTabs = [
  {
    key: 'PROFILE',
    title: 'Profile',
    icon: <IconUser size={18} />,
    href: '/settings/profile',
  },
  {
    key: 'TEAM',
    title: 'Team',
    icon: <IconUsers size={18} />,
    href: '/settings/team',
  },
  {
    key: 'BILLING',
    title: 'Billing',
    icon: <IconCreditCard size={18} />,
    href: '/settings/billing',
  },
  {
    key: 'INTEGRATIONS',
    title: 'Integrations',
    icon: <IconPlug size={18} />,
    href: '/settings/integrations',
  },
]
