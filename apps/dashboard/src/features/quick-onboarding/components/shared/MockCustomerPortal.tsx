/**
 * MockCustomerPortal - Customer Self-Service Portal Preview (Light Mode, Compact)
 * Dynamic preview showing the customer portal UI with organization branding
 * Matches MockMainPortal dimensions exactly
 */
'use client'

import {
  FileText,
  CreditCard,
  Activity,
  User,
  Bell,
  HelpCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * MockCustomerPortal - Customer Self-Service Portal Preview (Light Mode, Compact)
 * Dynamic preview showing the customer portal UI with organization branding
 * Matches MockMainPortal dimensions exactly
 */

interface MockCustomerPortalProps {
  organizationName: string
  primaryColor: string
  companyLogo?: string
}

const MockCustomerPortal = ({
  organizationName,
  primaryColor,
  companyLogo,
}: MockCustomerPortalProps) => {
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
        {/* Right side */}
        <div className='flex items-center gap-2'>
          <Bell className='h-3.5 w-3.5 text-neutral-400' />
          <HelpCircle className='h-3.5 w-3.5 text-neutral-400' />
          <div className='flex h-5 w-5 items-center justify-center rounded-full bg-neutral-200 text-[9px] font-medium text-neutral-500'>
            J
          </div>
        </div>
      </div>

      {/* Content */}
      <div className='flex h-[236px]'>
        {/* Sidebar */}
        <div className='w-28 space-y-0.5 border-r border-neutral-100 bg-neutral-50/30 px-1.5 py-2'>
          <NavItem
            icon={FileText}
            label='Invoices'
            active
            primaryColor={primaryColor}
            badge='3'
          />
          <NavItem icon={CreditCard} label='Payment' />
          <NavItem icon={Activity} label='Usage' />
          <NavItem icon={User} label='Profile' />
        </div>

        {/* Main Content */}
        <div className='flex-1 bg-neutral-50/50 p-3'>
          {/* Welcome Header */}
          <div className='mb-3'>
            <div className='text-[9px] text-neutral-400'>Welcome back</div>
            <div className='text-sm font-semibold text-neutral-900'>
              John Doe
            </div>
          </div>

          {/* Stats Cards */}
          <div className='mb-2.5 grid grid-cols-2 gap-2'>
            <QuickStatCard
              label='Current Balance'
              value='$245.00'
              primaryColor={primaryColor}
            />
            <QuickStatCard
              label='This Month'
              value='1,240 calls'
              primaryColor={primaryColor}
            />
          </div>

          {/* Recent Invoices */}
          <div className='rounded border border-neutral-100 bg-white p-2'>
            <div className='mb-2 flex items-center justify-between'>
              <span className='text-[9px] font-medium text-neutral-500'>
                Recent Invoices
              </span>
              <span className='text-[8px] text-neutral-400'>View all</span>
            </div>
            <div className='space-y-1.5'>
              {[
                { id: 'INV-001', amount: '$89.00', status: 'due' },
                { id: 'INV-002', amount: '$156.00', status: 'due' },
                { id: 'INV-003', amount: '$45.00', status: 'paid' },
              ].map((inv) => (
                <div key={inv.id} className='flex items-center justify-between'>
                  <div className='flex items-center gap-2'>
                    <div
                      className='h-1.5 w-1.5 rounded-full'
                      style={{
                        backgroundColor:
                          inv.status === 'due' ? primaryColor : '#d1d5db',
                      }}
                    />
                    <span className='text-[9px] text-neutral-600'>
                      {inv.id}
                    </span>
                  </div>
                  <span className='text-[9px] font-medium text-neutral-900'>
                    {inv.amount}
                  </span>
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
  badge,
}: {
  icon: React.ElementType
  label: string
  active?: boolean
  primaryColor?: string
  badge?: string
}) => (
  <div
    className={cn(
      'flex items-center justify-between rounded px-1.5 py-1 text-[10px] transition-colors',
      active ? 'font-medium' : 'text-neutral-400'
    )}
    style={
      active
        ? { backgroundColor: `${primaryColor}15`, color: primaryColor }
        : {}
    }
  >
    <div className='flex items-center gap-1.5'>
      <Icon className='h-3 w-3' />
      <span>{label}</span>
    </div>
    {badge && (
      <span
        className='rounded-full px-1 py-0.5 text-[8px] text-white'
        style={{ backgroundColor: primaryColor }}
      >
        {badge}
      </span>
    )}
  </div>
)

const QuickStatCard = ({
  label,
  value,
  primaryColor: _primaryColor,
}: {
  label: string
  value: string
  primaryColor: string
}) => (
  <div className='rounded border border-neutral-100 bg-white p-2'>
    <div className='mb-0.5 text-[8px] text-neutral-400'>{label}</div>
    <div className='text-xs font-semibold text-neutral-900'>{value}</div>
  </div>
)

export default MockCustomerPortal
