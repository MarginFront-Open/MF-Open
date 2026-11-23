import {
  CONTENT_TILE_CLASS,
  TileFrame,
  type TileStateProps,
} from '@/features/dashboard-shell/tiles/tile-frame'
import { TileHeader } from '@/features/dashboard-shell/tiles/tile-header'
import type { IqRule, IqRuleStatus } from '../iq-derivation'

// Total Record (the status-map pattern): a new IqRuleStatus is a compile
// error here, never a silently unstyled chip.
const STATUS_PILL: Record<IqRuleStatus, { label: string; className: string }> =
  {
    pass: { label: 'Pass', className: 'bg-mf-card2 text-mf-green' },
    review: { label: 'Review', className: 'bg-mf-card2 text-mf-amber' },
    fail: { label: 'Fail', className: 'bg-mf-card2 text-mf-red' },
    unknown: { label: 'No data', className: 'bg-mf-card2 text-mf-tx3' },
  }

export interface RulesListProps extends TileStateProps {
  title: string
  rules: IqRule[]
}

// Presentational only: rule text and status arrive pre-composed from the
// derivation module — this component formats and decides nothing.
export function RulesList({
  title,
  rules,
  state,
  errorMessage,
}: RulesListProps) {
  return (
    <TileFrame
      state={state}
      errorMessage={errorMessage}
      className={CONTENT_TILE_CLASS}
      loadingLines={4}
    >
      <TileHeader label={title} />
      <div className='mt-1.5 flex flex-col'>
        {rules.map((rule) => (
          <div key={rule.id} className='flex items-center gap-[10px] py-[6px]'>
            <span className='flex-1 text-[12px] text-mf-tx2'>{rule.text}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${STATUS_PILL[rule.status].className}`}
            >
              {STATUS_PILL[rule.status].label}
            </span>
          </div>
        ))}
      </div>
    </TileFrame>
  )
}
