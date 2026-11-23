'use client'

import {
  IconCreditCard,
  IconReceipt,
  IconFileInvoice,
  IconLock,
} from '@tabler/icons-react'
import { isAdmin } from '@/lib/permissions'
import { useCurrentOrganization } from '@/hooks/use-auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { InvoiceIdentityCard } from './invoice-identity-card'

export default function BillingSettings() {
  const { organization: currentOrg } = useCurrentOrganization()
  const userRole = currentOrg?.role
  const hasAdminAccess = isAdmin(userRole)
  return (
    <div className='max-w-3xl space-y-6'>
      <div>
        <div className='flex items-center gap-3'>
          <h2 className='section-header mt-0'>Billing & Payments</h2>
          {hasAdminAccess && (
            <Badge
              variant='secondary'
              className='border-primary/20 bg-primary/10 text-primary'
            >
              Admin Access
            </Badge>
          )}
        </div>
        <p className='text-description'>
          Manage your payment methods, billing information, and tax details.
        </p>
      </div>

      {!hasAdminAccess && (
        <div className='rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950'>
          <div className='flex items-start gap-3'>
            <IconLock className='mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700 dark:text-amber-400' />
            <div>
              <p className='text-sm font-medium text-amber-900 dark:text-amber-100'>
                View-Only Access
              </p>
              <p className='mt-1 text-xs text-amber-700 dark:text-amber-300'>
                You don&apos;t have permission to manage billing settings.
                Contact your organization admin for access.
              </p>
            </div>
          </div>
        </div>
      )}

      <InvoiceIdentityCard />

      <Card interactive className='card-md border-subtle'>
        <CardHeader>
          <div className='flex items-center gap-3'>
            <div className='rounded-lg bg-primary/10 p-2'>
              <IconCreditCard className='h-5 w-5 text-primary' />
            </div>
            <div>
              <CardTitle className='text-base'>Payment Methods</CardTitle>
              <CardDescription className='text-helper'>
                Manage your saved payment methods
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='rounded-lg border border-dashed border-border/50 bg-muted/20 px-4 py-8 text-center'>
            <p className='text-sm text-muted-foreground'>
              No payment methods saved
            </p>
            <Button variant='outline' size='sm' className='mt-3'>
              Add Payment Method
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card interactive className='card-md border-subtle'>
        <CardHeader>
          <div className='flex items-center gap-3'>
            <div className='rounded-lg bg-primary/10 p-2'>
              <IconReceipt className='h-5 w-5 text-primary' />
            </div>
            <div>
              <CardTitle className='text-base'>Tax Information</CardTitle>
              <CardDescription className='text-helper'>
                Update your tax ID and billing address
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className='space-y-4'>
            <div>
              <label className='label-standard'>Tax ID</label>
              <p className='mt-1 text-sm text-muted-foreground'>Not provided</p>
            </div>
            <Separator />
            <div>
              <label className='label-standard'>Billing Address</label>
              <p className='mt-1 text-sm text-muted-foreground'>Not provided</p>
            </div>
            <Button variant='outline' size='sm'>
              Update Tax Information
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card interactive className='card-md border-subtle'>
        <CardHeader>
          <div className='flex items-center gap-3'>
            <div className='rounded-lg bg-primary/10 p-2'>
              <IconFileInvoice className='h-5 w-5 text-primary' />
            </div>
            <div>
              <CardTitle className='text-base'>Invoices</CardTitle>
              <CardDescription className='text-helper'>
                View and download your invoices
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className='rounded-lg border border-dashed border-border/50 bg-muted/20 px-4 py-8 text-center'>
            <p className='text-sm text-muted-foreground'>No invoices yet</p>
            <p className='mt-1 text-xs text-muted-foreground/70'>
              Invoices will appear here after your first billing cycle
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
