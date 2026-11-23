/**
 * The Gauge tile's three optional
 * props for MF IQ: value is nullable, badge? renders a pill, and a
 * GaugeFix may carry an href. Contract (same as KpiTile overrides,
 * kpi-tile-overrides.test.ts): props ABSENT = the default rendering,
 * byte-identical — GAUGE_FIXTURE and the catalog preview pass none of the
 * three. jest is node-only, no RTL, so the wiring is source-asserted and
 * the fixture is checked at runtime.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { GAUGE_FIXTURE } from '../preview-fixtures'

const gaugeSrc = readFileSync(
  join(__dirname, '..', 'tiles', 'gauge.tsx'),
  'utf8'
)

describe('GaugeProps — the three widenings are additive', () => {
  it('value is widened to number | null (still required)', () => {
    expect(gaugeSrc).toMatch(/value: number \| null/)
  })

  it('badge is OPTIONAL (absent = nothing renders)', () => {
    expect(gaugeSrc).toMatch(/badge\?: string/)
  })

  it('GaugeFix.href is OPTIONAL (absent = plain span, no Link)', () => {
    expect(gaugeSrc).toMatch(/href\?: string/)
  })
})

describe('null-score rendering — honest, never 0/10', () => {
  it("renders the number as the dash literal via {value ?? '—'} (keeps / max)", () => {
    expect(gaugeSrc).toMatch(/\{value \?\? '—'\}/)
  })

  it('the ring fraction guards on value !== null (dash 0 when null)', () => {
    expect(gaugeSrc).toMatch(/value !== null && max > 0/)
  })

  it('the fixes-to-reach target only renders for a non-null value (no fake arithmetic over null)', () => {
    expect(gaugeSrc).toMatch(/\{value !== null &&\s*\n?\s*` to reach/)
  })
})

describe('default rendering with no override props', () => {
  it('keeps the fixes-to-reach formula verbatim', () => {
    expect(gaugeSrc).toContain(
      'Math.min(max, value + fixes.reduce((sum, f) => sum + f.points, 0))'
    )
  })

  it('badge renders only when present', () => {
    expect(gaugeSrc).toMatch(/\{badge && \(/)
  })

  it('a fix without href still renders the original plain span', () => {
    expect(gaugeSrc).toMatch(/fix\.href \? \(/)
    // Whitespace-tolerant: prettier may wrap this JSX across lines.
    expect(gaugeSrc).toMatch(
      /<span className='flex-1 text-\[12px\] text-mf-tx2'>\s*\{fix\.label\}\s*<\/span>/
    )
  })

  it('a fix WITH href wraps the label in next/link with the AlertList hover grammar', () => {
    expect(gaugeSrc).toMatch(/import Link from 'next\/link'/)
    expect(gaugeSrc).toMatch(/href=\{fix\.href\}/)
    expect(gaugeSrc).toMatch(/hover:text-mf-accent/)
  })
})

describe('GAUGE_FIXTURE: passes none of the three override props (absent = default)', () => {
  it('has no badge', () => {
    expect(GAUGE_FIXTURE).not.toHaveProperty('badge')
  })

  it('has no fix hrefs', () => {
    for (const fix of GAUGE_FIXTURE.fixes ?? []) {
      expect(fix).not.toHaveProperty('href')
    }
  })

  it('still passes a plain number value (the widened type is exercised only by MF IQ)', () => {
    expect(typeof GAUGE_FIXTURE.value).toBe('number')
  })
})
