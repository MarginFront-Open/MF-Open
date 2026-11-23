import { InfoTooltip } from '@/components/ui/info-tooltip'

export interface TileHeaderTooltip {
  title: string
  description: string
  details?: string
}

export interface TileHeaderProps {
  label: string
  tooltip?: TileHeaderTooltip
}

// The kpi-tile header treatment (uppercase label + optional info icon),
// extracted so every catalog tile's title reads the same. Takes a
// resolved tooltip object, not a key:
// kpi-tile's registry-fallback lookup stays at its own call site.
export function TileHeader({ label, tooltip }: TileHeaderProps) {
  return (
    <div className='flex items-center gap-1.5'>
      <span className='text-[10.5px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
        {label}
      </span>
      {tooltip && (
        <InfoTooltip
          title={tooltip.title}
          description={tooltip.description}
          details={tooltip.details}
          iconSize='h-3 w-3'
        />
      )}
    </div>
  )
}
