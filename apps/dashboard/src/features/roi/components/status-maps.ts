/**
 * Pure, node-testable view
 * maps for the ROI cards. HEALTH_PILLS is a TOTAL Record over
 * InitiativeHealth so a new health state is a compile error here (the
 * status-map pattern). The progress fill is amber ONLY for 'at-risk': a
 * behind-pace initiative's fuller bar must never read as better than an
 * on-track one's.
 */

import type { InitiativeHealth } from '../progress-derivation'

export interface HealthPill {
  label: string
  className: string
}

export const HEALTH_PILLS: Record<InitiativeHealth, HealthPill> = {
  'on-track': { label: 'On track', className: 'bg-mf-card2 text-mf-green' },
  'at-risk': { label: 'At risk', className: 'bg-mf-card2 text-mf-amber' },
  achieved: { label: 'Achieved', className: 'bg-mf-card2 text-mf-green' },
  'not-started': {
    label: 'Not started',
    className: 'bg-mf-card2 text-mf-tx2',
  },
  'no-data': { label: 'No data yet', className: 'bg-mf-card2 text-mf-tx2' },
  archived: { label: 'Archived', className: 'bg-mf-card2 text-mf-tx3' },
}

export function progressFillClass(health: InitiativeHealth): string {
  return health === 'at-risk' ? 'bg-mf-amber' : 'bg-mf-accent'
}
