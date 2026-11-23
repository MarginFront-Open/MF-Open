'use client'

import { Page } from '@/components/layouts/page'
import { TaxonomyCard } from '@/components/taxonomy-card'

// The "Key Concepts" page lives in Developer Zone and is the canonical
// reference for understanding how usage data flows through the platform.
// It answers: "What are metrics, events, and units?" in one place.

export default function KeyConceptsPage() {
  return (
    <Page
      title='Key Concepts'
      headerProps={{
        // Breadcrumb reads "Home > Key Concepts". No "Developer Zone" crumb:
        // /developer-zone has no index page.
        breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Key Concepts' }],
      }}
    >
      <div className='flex flex-col gap-6'>
        {/* Intro */}
        <div className='max-w-2xl'>
          <h2 className='text-xl font-semibold'>
            Understanding Your Usage Data
          </h2>
          <p className='mt-2 text-sm text-muted-foreground'>
            Everything in MarginFront is built around three simple concepts:
            what you track (Metrics), when it happens (Events), and how much
            (Units). This page explains all the terms you&apos;ll see across the
            dashboard.
          </p>
        </div>

        {/* Full taxonomy card with detailed explanations */}
        <TaxonomyCard variant='full' />
      </div>
    </Page>
  )
}
