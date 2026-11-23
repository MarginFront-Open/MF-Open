import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// The 4 states every catalog
// component renders. Shared here so all 7 tiles agree on the same union
// and the same card chrome, rather than each tile re-deriving it.
export type TileState = 'loading' | 'empty' | 'error' | 'ready'

export interface TileStateProps {
  state?: TileState
  errorMessage?: string
}

interface TileFrameProps extends TileStateProps {
  // Merged onto the card's own border/radius/bg so every branch (loading,
  // empty, error, ready) renders at the SAME size — no layout jump.
  className?: string
  loadingLines?: number
  // An empty alert-list reads as "Nothing needs attention,"
  // not the generic no-data message every other tile shares.
  emptyMessage?: string
  // The tile's header, rendered in ALL FOUR states. It sits outside
  // `children` because loading/empty/error swap the children away, which
  // would leave e.g. an empty "Needs attention" tile as an unlabeled card.
  header?: ReactNode
  children: ReactNode
}

const CARD_BASE = 'rounded-mf-card border border-mf-bd bg-mf-card'

// The ONE frame class for content-band card tiles (alerts,
// checklist, gauge, donut) so a shared row always lines up. h-full
// stretches a card to its row; 220 is the floor when it anchors its own.
// Deliberately NOT applied to kpi-tile (fixed h-[146px]) or chart/table,
// whose taller floors match their ready-state content — flattening them to
// 220 would make them jump in height from loading to ready.
export const CONTENT_TILE_CLASS = 'h-full min-h-[220px] px-[17px] py-[15px]'

export function TileFrame({
  state = 'ready',
  errorMessage,
  className,
  loadingLines = 3,
  emptyMessage = 'No data for this period',
  header,
  children,
}: TileFrameProps) {
  if (state === 'loading') {
    const lines = Array.from({ length: loadingLines }).map((_, i) => (
      <Skeleton key={i} className='mb-2 h-4 w-full last:mb-0' />
    ))
    return (
      <div className={cn(CARD_BASE, className)}>
        {header}
        {header ? <div className='mt-3'>{lines}</div> : lines}
      </div>
    )
  }

  if (state === 'empty' || state === 'error') {
    const message = (
      <span className='text-[12px] text-mf-tx3'>
        {state === 'empty'
          ? emptyMessage
          : (errorMessage ??
            'This tile could not load. Refresh the page to try again.')}
      </span>
    )
    if (!header) {
      return (
        <div
          className={cn(
            CARD_BASE,
            'flex items-center',
            state === 'empty' && 'justify-center',
            className
          )}
        >
          {message}
        </div>
      )
    }
    return (
      <div className={cn(CARD_BASE, 'flex flex-col', className)}>
        {header}
        <div
          className={cn(
            'flex flex-1 items-center',
            state === 'empty' && 'justify-center'
          )}
        >
          {message}
        </div>
      </div>
    )
  }

  return (
    <div className={cn(CARD_BASE, className)}>
      {header}
      {children}
    </div>
  )
}
