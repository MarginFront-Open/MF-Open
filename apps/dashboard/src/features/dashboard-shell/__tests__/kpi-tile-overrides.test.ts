/**
 * KpiTile's optional
 * tooltipKey/label overrides. Contract: props ABSENT = registry defaults
 * (the same contract as DimensionedSection's showChart);
 * props PRESENT = the caller's honest copy. jest is node-only, no RTL, so
 * the fallback wiring is source-asserted (the shell-safety pattern) and the
 * override's TARGET copy is verified for real against tooltip-definitions.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { TILE_METRIC_REGISTRY } from '@/lib/component-catalog'

const kpiTileSrc = readFileSync(
  join(__dirname, '..', 'tiles', 'kpi-tile.tsx'),
  'utf8'
)

describe('KpiTileProps — both overrides are OPTIONAL (absent = registry default)', () => {
  it('declares tooltipKey?: TooltipKey', () => {
    expect(kpiTileSrc).toMatch(/tooltipKey\?: TooltipKey/)
  })

  it('declares label?: string', () => {
    expect(kpiTileSrc).toMatch(/label\?: string/)
  })
})

describe('KpiTile — fallback wiring (present = override, absent = registry)', () => {
  it('tooltip lookup is tooltipDefinitions[tooltipKey ?? registryEntry.tooltipKey]', () => {
    expect(kpiTileSrc).toMatch(
      /tooltipDefinitions\[tooltipKey \?\? registryEntry\.tooltipKey\]/
    )
  })

  it('caption renders label ?? registryEntry.label', () => {
    expect(kpiTileSrc).toMatch(/\{label \?\? registryEntry\.label\}/)
  })
})

describe('the override target (agent-detail margin tile)', () => {
  it('agentEarnedMargin exists in tooltip-definitions with earned-basis copy', () => {
    const tooltip = tooltipDefinitions.agentEarnedMargin
    expect(tooltip.title).toBe('Earned Margin')
    expect(tooltip.description).toMatch(/no subscription or seat fees/)
  })

  it("differs from marginPercent's registry default — the override does real work (retire it if the registry ever flips)", () => {
    expect(TILE_METRIC_REGISTRY.marginPercent.tooltipKey).not.toBe(
      'agentEarnedMargin'
    )
  })
})
