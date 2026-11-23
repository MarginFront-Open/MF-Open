/**
 * MockMainPortal - Admin Dashboard Preview (Light Mode, Compact)
 * Dynamic preview showing the main portal UI with organization branding
 */
'use client'

import {
  LayoutDashboard,
  Users,
  CreditCard,
  Activity,
  Settings,
  TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SkeletonBar } from './SkeletonBar'

/**
 * MockMainPortal - Admin Dashboard Preview (Light Mode, Compact)
 * Dynamic preview showing the main portal UI with organization branding
 */

interface MockMainPortalProps {
  organizationName: string
  primaryColor: string
  companyLogo?: string
}

const MockMainPortal = ({
  organizationName,
  primaryColor,
  companyLogo,
}: MockMainPortalProps) => {
  const initial = organizationName?.[0]?.toUpperCase() || 'U'
  const displayName = organizationName || 'Your Company'

  return (
    <div className='h-[280px] w-[420px] overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl'>
      {/* Header */}
      <div className='flex items-center justify-between border-b border-neutral-100 bg-neutral-50/50 px-3 py-2.5'>
        <div className='flex items-center gap-2'>
          {/* Logo/Favicon */}
          {companyLogo ? (
            <img
              src={companyLogo}
              alt={displayName}
              className='h-7 w-7 rounded-md object-contain shadow-sm'
              onError={(e) => {
                // Fallback to initial letter on error
                e.currentTarget.style.display = 'none'
                e.currentTarget.nextElementSibling?.classList.remove('hidden')
              }}
            />
          ) : null}
          <div
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold text-white shadow-sm',
              companyLogo && 'hidden'
            )}
            style={{ backgroundColor: primaryColor || '#10b981' }}
          >
            {initial}
          </div>
          <span className='text-xs font-medium text-neutral-900'>
            {displayName}
          </span>
        </div>
        <div className='flex items-center gap-1.5'>
          <SkeletonBar
            width='2.5rem'
            height='0.375rem'
            className='bg-neutral-200'
          />
          <div className='h-5 w-5 rounded-full bg-neutral-200' />
        </div>
      </div>

      {/* Content */}
      <div className='flex h-[236px]'>
        {/* Sidebar */}
        <div className='w-28 space-y-0.5 border-r border-neutral-100 bg-neutral-50/30 px-1.5 py-2'>
          <NavItem
            icon={LayoutDashboard}
            label='Overview'
            active
            primaryColor={primaryColor}
          />
          <NavItem icon={Users} label='Customers' />
          <NavItem icon={CreditCard} label='Billing' />
          <NavItem icon={Activity} label='Usage' />
          <NavItem icon={Settings} label='Settings' />
        </div>

        {/* Main Content */}
        <div className='flex-1 space-y-2.5 bg-neutral-50/50 p-3'>
          {/* Stats Row */}
          <div className='grid grid-cols-2 gap-2'>
            <StatCard
              label='Revenue'
              value='$12,450'
              trend='+12%'
              primaryColor={primaryColor}
            />
            <StatCard
              label='Customers'
              value='248'
              trend='+8%'
              primaryColor={primaryColor}
            />
          </div>

          {/* Mini Table */}
          <div className='rounded border border-neutral-100 bg-white p-2'>
            <div className='mb-2 flex items-center justify-between'>
              <span className='text-[9px] font-medium text-neutral-500'>
                Recent Activity
              </span>
              <SkeletonBar
                width='1.5rem'
                height='0.25rem'
                className='bg-neutral-200'
              />
            </div>
            <div className='space-y-1.5'>
              {[1, 2, 3].map((i) => (
                <div key={i} className='flex items-center gap-2'>
                  <div
                    className='h-1.5 w-1.5 rounded-full'
                    style={{
                      backgroundColor: i === 1 ? primaryColor : '#e5e7eb',
                    }}
                  />
                  <SkeletonBar
                    width={`${50 + i * 12}%`}
                    height='0.25rem'
                    className='bg-neutral-200'
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const NavItem = ({
  icon: Icon,
  label,
  active,
  primaryColor,
}: {
  icon: React.ElementType
  label: string
  active?: boolean
  primaryColor?: string
}) => (
  <div
    className={cn(
      'flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px] transition-colors',
      active ? 'font-medium' : 'text-neutral-400'
    )}
    style={
      active
        ? { backgroundColor: `${primaryColor}15`, color: primaryColor }
        : {}
    }
  >
    <Icon className='h-3 w-3' />
    <span>{label}</span>
  </div>
)

const StatCard = ({
  label,
  value,
  trend,
  primaryColor,
}: {
  label: string
  value: string
  trend: string
  primaryColor: string
}) => (
  <div className='rounded border border-neutral-100 bg-white p-2'>
    <div className='mb-0.5 text-[9px] text-neutral-400'>{label}</div>
    <div className='flex items-end justify-between'>
      <span className='text-sm font-semibold text-neutral-900'>{value}</span>
      <span
        className='flex items-center gap-0.5 text-[9px] font-medium'
        style={{ color: primaryColor }}
      >
        <TrendingUp className='h-2.5 w-2.5' />
        {trend}
      </span>
    </div>
  </div>
)

export default MockMainPortal
