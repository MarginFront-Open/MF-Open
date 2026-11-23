'use client'

/**
 * WHAT THIS FILE DOES: the permanent way back into the tour, and the only door
 * to the three optional chapters.
 *
 * WHY IT LIVES IN THE PAGE HEADER: a help affordance has to sit in the same
 * place on every page that has one (WCAG 3.2.6), so this is the first item in
 * headerExtras and the same slot is what any other page would use. It is also
 * why the tour can afford to be short: everything the core six steps leave out
 * is one menu away rather than four more cards nobody reads.
 */

import { Compass } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  TOUR_LAUNCHER_ACCESSIBLE_NAME,
  TOUR_LAUNCHER_LABEL,
  TOUR_MENU_ITEMS,
  type TourPlanId,
} from './tour-steps'

export function ShowMeAround({
  onStart,
}: {
  /** null means "whichever tour this organization resolves to right now". */
  onStart: (planId: TourPlanId | null) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-tour='show-me-around'
        aria-label={TOUR_LAUNCHER_ACCESSIBLE_NAME}
        className='inline-flex h-7 items-center gap-1.5 rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
      >
        <Compass className='h-3 w-3' aria-hidden='true' />
        {TOUR_LAUNCHER_LABEL}
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {TOUR_MENU_ITEMS.map((item) => (
          <DropdownMenuItem
            key={item.label}
            onSelect={() => onStart(item.planId)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
