'use client'

import React from 'react'
import { useSearchParams } from 'next/navigation'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { signalEventsKeys } from '@/services/signal-events-service'
import { RefreshCw } from 'lucide-react'
import { Page } from '@/components/layouts/page'
import { Button } from '@/components/ui/button'
import RawEventsTable from './components/RawEventsTable'

const SignalEventsPage: React.FC = () => {
  const queryClient = useQueryClient()
  // The table owns the active list query (its key carries page/filters/sort),
  // so Reload can't hold that query itself — it invalidates the whole list
  // family and tracks the in-flight refetch via useIsFetching for the spinner.
  const isFetching = useIsFetching({ queryKey: signalEventsKeys.lists() }) > 0

  // Deep-link support: /metrics-events/raw-events?eventId=<uuid> auto-opens
  // the Event Details Sidebar for that specific event. The needs-attention
  // dialog success flow uses this to jump users straight to a verifiable
  // view of a just-backfilled event — no manual row hunt required.
  const searchParams = useSearchParams()
  const autoOpenEventId = searchParams.get('eventId') ?? undefined

  return (
    <Page
      title='Ingestion Log'
      description='Every raw usage payload your SDK sends in. Use this for debugging and verifying data.'
      headerProps={{
        breadcrumb: [
          { name: 'Home', href: '/' },
          { name: 'Usage Events', href: '/metrics-events' },
          { name: 'Ingestion Log' },
        ],
        actionButtons: (
          <Button
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: signalEventsKeys.lists(),
              })
            }
            variant='outline'
            disabled={isFetching}
            className='gap-2'
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`}
            />
            Reload
          </Button>
        ),
      }}
    >
      <RawEventsTable enableControls autoOpenEventId={autoOpenEventId} />
    </Page>
  )
}

export default SignalEventsPage
