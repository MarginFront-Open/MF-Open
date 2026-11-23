import type { TooltipKey } from '@/lib/component-catalog'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import {
  CONTENT_TILE_CLASS,
  TileFrame,
  type TileStateProps,
} from './tile-frame'
import { TileHeader } from './tile-header'

export interface ChecklistItem {
  label: string
  status: 'done' | 'active' | 'todo'
  detail?: string
}

export interface ChecklistProps extends TileStateProps {
  title: string
  tooltipKey?: TooltipKey
  items: ChecklistItem[]
}

function ChecklistMarker({ status }: { status: ChecklistItem['status'] }) {
  if (status === 'done') {
    return (
      <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-mf-green text-[9px] font-bold text-[#06140d]'>
        ✓
      </span>
    )
  }
  if (status === 'active') {
    return (
      <span className='h-4 w-4 shrink-0 rounded-full border-2 border-mf-accent' />
    )
  }
  return <span className='h-4 w-4 shrink-0 rounded-full border border-mf-bd' />
}

export function Checklist({
  title,
  tooltipKey,
  items,
  state,
  errorMessage,
}: ChecklistProps) {
  return (
    <TileFrame
      state={state}
      errorMessage={errorMessage}
      className={CONTENT_TILE_CLASS}
      loadingLines={5}
      header={
        <TileHeader
          label={title}
          tooltip={tooltipKey ? tooltipDefinitions[tooltipKey] : undefined}
        />
      }
    >
      <div className='mt-1.5 flex flex-col'>
        {items.map((item) => (
          <div
            key={item.label}
            className='flex items-center gap-[10px] py-[6px]'
          >
            <ChecklistMarker status={item.status} />
            <span
              className={`flex-1 text-[12.5px] ${
                item.status === 'active'
                  ? 'font-medium text-mf-tx'
                  : 'font-normal text-mf-tx2'
              }`}
            >
              {item.label}
            </span>
            {item.detail && (
              <span
                className={`text-[11px] ${
                  item.status === 'active'
                    ? 'font-medium text-mf-accent'
                    : 'text-mf-tx3'
                }`}
              >
                {item.detail}
              </span>
            )}
          </div>
        ))}
      </div>
    </TileFrame>
  )
}
