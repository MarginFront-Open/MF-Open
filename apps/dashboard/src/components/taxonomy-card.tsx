'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, BookOpen } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

// Shows how usage data is organized: Metric → Event → Quantity (Units).
// Think of it like a folder structure: Metrics contain Events, Events have a Quantity.

interface TaxonomyCardProps {
  // "compact" = collapsible card for the Home page
  // "full" = detailed version for the Key Concepts page
  variant: 'compact' | 'full'
}

// Remember whether the user has already seen (and collapsed) the card
const STORAGE_KEY = 'taxonomy-card-collapsed'

// Read localStorage once at init to avoid setState-in-useEffect lint issues
function getInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return true
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === null) {
    // First visit — show expanded, and remember that for next time
    localStorage.setItem(STORAGE_KEY, 'false')
    return false
  }
  return stored === 'true'
}

export function TaxonomyCard({ variant }: TaxonomyCardProps) {
  // Compact variant starts collapsed after first visit
  const [isCollapsed, setIsCollapsed] = useState(() =>
    variant === 'compact' ? getInitialCollapsed() : false
  )

  const handleToggle = () => {
    const next = !isCollapsed
    setIsCollapsed(next)
    localStorage.setItem(STORAGE_KEY, String(next))
  }

  // The visual hierarchy that both variants share
  const hierarchyVisual = (
    <div className='space-y-3 rounded-lg bg-muted/50 p-4 font-mono text-sm'>
      <div className='flex items-start gap-2'>
        <span className='font-semibold text-primary'>Metric</span>
        <span className='text-muted-foreground'>(what you track)</span>
        <span className='ml-auto text-xs italic text-muted-foreground'>
          e.g., &quot;API Calls&quot;
        </span>
      </div>
      <div className='flex items-start gap-2 pl-4'>
        <span className='text-muted-foreground'>└─</span>
        <span className='font-semibold text-primary'>Event</span>
        <span className='text-muted-foreground'>(one occurrence)</span>
        <span className='ml-auto text-xs italic text-muted-foreground'>
          e.g., &quot;Customer X made an API call&quot;
        </span>
      </div>
      <div className='flex items-start gap-2 pl-10'>
        <span className='text-muted-foreground'>└─</span>
        <span className='font-semibold text-primary'>Quantity</span>
        <span className='text-muted-foreground'>(how many units)</span>
        <span className='ml-auto text-xs italic text-muted-foreground'>
          e.g., &quot;17 units&quot;
        </span>
      </div>
    </div>
  )

  // --- COMPACT VARIANT (Home page) ---
  if (variant === 'compact') {
    return (
      <Card className='border-dashed'>
        <CardHeader className='pb-2'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <BookOpen className='h-4 w-4 text-muted-foreground' />
              <CardTitle className='text-sm font-medium'>
                How Usage Works
              </CardTitle>
            </div>
            <Button
              variant='ghost'
              size='sm'
              onClick={handleToggle}
              className='h-7 w-7 p-0'
              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            >
              {isCollapsed ? (
                <ChevronDown className='h-4 w-4' />
              ) : (
                <ChevronUp className='h-4 w-4' />
              )}
            </Button>
          </div>
        </CardHeader>
        {!isCollapsed && (
          <CardContent className='pt-0'>
            <p className='mb-3 text-xs text-muted-foreground'>
              Your usage is made up of <strong>metrics</strong> (the things your
              AI agents do), <strong>events</strong> (each time they do it), and{' '}
              <strong>units</strong> (how many times in that event).
            </p>
            {hierarchyVisual}
            <div className='mt-3 flex justify-end'>
              <Button variant='link' size='sm' asChild className='h-auto p-0'>
                <Link href='/developer-zone/key-concepts'>Learn more →</Link>
              </Button>
            </div>
          </CardContent>
        )}
      </Card>
    )
  }

  // --- FULL VARIANT (Key Concepts page) ---
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <BookOpen className='h-5 w-5' />
          Usage Hierarchy
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        <p className='text-sm text-muted-foreground'>
          Your usage is made up of <strong>metrics</strong> (the things your AI
          agents do), <strong>events</strong> (each time they do it), and{' '}
          <strong>units</strong> (how many times in that event).
        </p>
        {hierarchyVisual}

        {/* Detailed explanations for each level */}
        <div className='mt-6 space-y-4'>
          <div className='rounded-lg border p-4'>
            <h4 className='font-semibold'>Usage Metric</h4>
            <p className='mt-1 text-sm text-muted-foreground'>
              A measurable activity that generates value for your customers,
              like &quot;API Calls,&quot; &quot;Storage GB,&quot; or
              &quot;Messages Sent.&quot; You define metrics when you set up an
              agent.
            </p>
          </div>

          <div className='rounded-lg border p-4'>
            <h4 className='font-semibold'>Usage Event</h4>
            <p className='mt-1 text-sm text-muted-foreground'>
              A single recorded occurrence of a metric. Each time a customer
              uses a tracked feature, your SDK creates a usage event. One event
              = one row in the database.
            </p>
          </div>

          <div className='rounded-lg border p-4'>
            <h4 className='font-semibold'>Quantity (Units)</h4>
            <p className='mt-1 text-sm text-muted-foreground'>
              The numeric amount recorded in each event. This is the count or
              measurement of usage. For example, a single event might report
              &quot;17 units&quot; of API calls.
            </p>
            <div className='mt-2 rounded bg-muted/50 p-2 text-xs text-muted-foreground'>
              <strong>Key distinction:</strong> Events = how many times
              something happened. Units = the total amount across those events.
              <br />
              Example: 3 events with quantities of 5, 10, and 2 = 3 events, 17
              units.
            </div>
          </div>
        </div>

        {/* Metric Types */}
        <div className='mt-6'>
          <h3 className='mb-3 text-lg font-semibold'>Metric Types</h3>
          <div className='grid gap-4 sm:grid-cols-2'>
            <div className='rounded-lg border p-4'>
              <h4 className='font-semibold'>Volume-Based</h4>
              <p className='mt-1 text-sm text-muted-foreground'>
                Charges for every action, regardless of the result. Good for
                things like API calls, file uploads, or storage reads.
              </p>
            </div>
            <div className='rounded-lg border p-4'>
              <h4 className='font-semibold'>Usage-Based (Outcome)</h4>
              <p className='mt-1 text-sm text-muted-foreground'>
                Only charges for successful outcomes. Good for tasks where you
                only want to bill when something useful was completed.
              </p>
            </div>
          </div>
        </div>

        {/* Cost Terms */}
        <div className='mt-6'>
          <h3 className='mb-3 text-lg font-semibold'>
            Cost &amp; Pricing Terms
          </h3>
          <div className='grid gap-4 sm:grid-cols-3'>
            <div className='rounded-lg border p-4'>
              <h4 className='font-semibold'>Unit Cost</h4>
              <p className='mt-1 text-sm text-muted-foreground'>
                Your internal cost to deliver one unit of a metric.
              </p>
            </div>
            <div className='rounded-lg border p-4'>
              <h4 className='font-semibold'>Unit Price</h4>
              <p className='mt-1 text-sm text-muted-foreground'>
                The default price customers pay per unit.
              </p>
            </div>
            <div className='rounded-lg border p-4'>
              <h4 className='font-semibold'>Usage Charge</h4>
              <p className='mt-1 text-sm text-muted-foreground'>
                The calculated charge for an event (quantity × pricing rules).
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
