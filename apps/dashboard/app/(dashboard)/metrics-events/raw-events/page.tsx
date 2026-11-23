'use client'

import { Suspense } from 'react'
import SignalEventsPage from '@/features/signal-events'

// Suspense is required because SignalEventsPage calls useSearchParams()
// to read ?eventId=<id> for the deep-link auto-open. Next.js 16 mandates
// the boundary or the param can arrive late / not at all during
// client-render.
export default function RawEventsRoute() {
  return (
    <Suspense fallback={null}>
      <SignalEventsPage />
    </Suspense>
  )
}
