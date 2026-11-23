import Link from 'next/link'
import type { TooltipKey } from '@/lib/component-catalog'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import {
  CONTENT_TILE_CLASS,
  TileFrame,
  type TileStateProps,
} from './tile-frame'
import { TileHeader } from './tile-header'

export interface AlertListItem {
  severity: 'red' | 'amber' | 'green'
  // Arrives pre-composed by the page that built this list — this component
  // never formats money itself (the composing page uses canon-format).
  text: string
  href?: string
  timestamp?: string
}

export interface AlertListProps extends TileStateProps {
  title: string
  tooltipKey?: TooltipKey
  items: AlertListItem[]
  emptyMessage?: string
}

const DOT_CLASS_BY_SEVERITY: Record<AlertListItem['severity'], string> = {
  red: 'bg-mf-red',
  amber: 'bg-mf-amber',
  green: 'bg-mf-green',
}

function AlertRow({ item }: { item: AlertListItem }) {
  return (
    <div className='flex items-center gap-[10px] py-[6px]'>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS_BY_SEVERITY[item.severity]}`}
      />
      <span className='flex-1 text-[12px] text-mf-tx2'>{item.text}</span>
      {item.timestamp && (
        <span className='text-[10.5px] text-mf-tx3'>{item.timestamp}</span>
      )}
      {item.href && (
        <Link
          href={item.href}
          className='text-[11px] text-mf-tx3 hover:text-mf-accent'
        >
          View →
        </Link>
      )}
    </div>
  )
}

export function AlertList({
  title,
  tooltipKey,
  items,
  state,
  errorMessage,
  emptyMessage,
}: AlertListProps) {
  return (
    <TileFrame
      state={state}
      errorMessage={errorMessage}
      emptyMessage={emptyMessage}
      className={CONTENT_TILE_CLASS}
      loadingLines={4}
      header={
        <TileHeader
          label={title}
          tooltip={tooltipKey ? tooltipDefinitions[tooltipKey] : undefined}
        />
      }
    >
      <div className='mt-1.5 flex flex-col'>
        {items.map((item, i) => (
          <AlertRow key={`${item.text}-${i}`} item={item} />
        ))}
      </div>
    </TileFrame>
  )
}
