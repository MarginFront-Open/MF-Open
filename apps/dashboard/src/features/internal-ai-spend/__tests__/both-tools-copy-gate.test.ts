import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Copy gates. The spend-controls surfaces must tell the both-tools truth:
 * an Enforce cap pauses Claude Code AND Codex tool calls on armed machines.
 * These gates fail if wording claims only Claude Code is paused, or if
 * the permanent honesty sentences (Gemini/xAI count but aren't paused;
 * guardrail, not hard limit) quietly vanish. Dashboard jest is node-only, so
 * like the other wiring tests these assert against the component source.
 */
const FEATURE = join(__dirname, '..')
const tabSource = readFileSync(join(FEATURE, 'index.tsx'), 'utf8')

describe('internal-ai-spend/index.tsx — the both-tools truth', () => {
  it('the enforce bullet names Claude Code and Codex', () => {
    expect(tabSource).toContain('stops Claude Code and Codex work')
  })

  // "Installed" and "armed" are two different machines. A meter-only install
  // counts spend and pauses nothing, and a Codex arm sits inert until the
  // developer trusts it in /hooks. Promising a stop everywhere the meter is
  // installed promises one those machines can't deliver, so the bullet uses the
  // same word MODE_COPY.enforce does.
  it('the enforce bullet promises a stop only on ARMED machines', () => {
    expect(tabSource).toContain('machines where this cap is armed')
    expect(tabSource).not.toContain('machines where the meter is installed')
  })

  it('the guardrail note pauses both tools and keeps the honesty list', () => {
    expect(tabSource).toContain('pause Claude Code and Codex tool calls')
    // Gemini/xAI spend counts toward a cap but is not paused.
    expect(tabSource).toContain('Gemini, xAI')
    expect(tabSource).toMatch(/counts toward a\s+cap but isn&apos;t paused/)
    // A guardrail, not a hard limit: a machine can skip installing it.
    expect(tabSource).toContain('This is a guardrail, not a hard limit.')
    expect(tabSource).toMatch(/never installed\s+it/)
  })

  it('every pause claim names both tools', () => {
    expect(tabSource).not.toMatch(/pauses? Claude Code only/i)
    expect(tabSource).not.toMatch(/Claude Code is the only/i)
    expect(tabSource).not.toMatch(
      /only Claude Code (?:tool calls? |work )?(?:is|are) paused/i
    )
  })

  // These gates pin the display side: a correct per-tool query still ships
  // the wrong number if the tab renders the blend.
  it('never renders a blended armed count across both tools', () => {
    expect(tabSource).not.toContain('computeCoverage')
    expect(tabSource).not.toContain('data.coverage.armed')
    expect(tabSource).not.toContain('data.coverage.total')
  })

  it('renders one coverage line per tool, each from its own counts', () => {
    expect(tabSource).toContain(
      "toolCoverageLine('Claude Code', claudeCoverage)"
    )
    expect(tabSource).toContain("toolCoverageLine('Codex', codexCoverage)")
    expect(tabSource).toContain('data.coverage.claudeCode')
    expect(tabSource).toContain('data.coverage.codex')
  })

  it('keeps the cannot-tell explainer gated on there actually being unknowns', () => {
    expect(tabSource).toContain('COVERAGE_UNKNOWN_NOTE')
    expect(tabSource).toMatch(
      /anyUnknown\s*=\s*claudeCoverage\.unknown > 0 \|\| codexCoverage\.unknown > 0/
    )
    expect(tabSource).toMatch(/\{anyUnknown \?/)
  })

  it('falls back to the single no-activity line when neither tool saw anyone', () => {
    expect(tabSource).toContain('COVERAGE_NO_ACTIVITY_LINE')
    expect(tabSource).toMatch(
      /anyToolActivity\s*=\s*claudeCoverage\.total > 0 \|\| codexCoverage\.total > 0/
    )
  })

  // The headline says the cap CHECK is running, and the caps live on another
  // subtab. Without this sentence beside it, an org with zero caps reads "5 of 5
  // teammates have the cap check running" and "No caps yet." at the same time,
  // with nothing on screen reconciling them.
  it('renders the check-is-not-a-cap note wherever a coverage line renders', () => {
    expect(tabSource).toContain('COVERAGE_CHECK_SCOPE_NOTE')
  })

  // Codex is answered per working directory. The tab names which one rather than
  // implying per-project coverage the daemon cannot see.
  it('names the Codex scope, and only when Codex was actually used', () => {
    expect(tabSource).toContain('COVERAGE_CODEX_SCOPE_NOTE')
    expect(tabSource).toMatch(/\{codexCoverage\.total > 0 \?/)
  })

  // The roster note is a constant, not inline JSX, so the copy style gate in
  // copy-style-gate.test.ts reaches it.
  it('reads the roster note from the tested constant, not from inline JSX', () => {
    expect(tabSource).toContain('COVERAGE_ROSTER_NOTE')
    expect(tabSource).not.toContain('if they code from more than one machine')
  })

  // These strings are constants so the copy style gate reaches them, and this
  // keeps them out of inline JSX.
  it('reads the no-bar cap lines from tested constants', () => {
    expect(tabSource).toContain('CAP_NO_BAR_TEAM')
    expect(tabSource).toContain('CAP_NO_BAR_PROVIDER')
    expect(tabSource).not.toContain("there's no bar for this cap")
  })

  it('stays guard-safe: the tab never says block, bypass, or deny', () => {
    // A flat check over the whole file, comments and identifiers included:
    // none of these words appear anywhere in it.
    const lower = tabSource.toLowerCase()
    expect(lower).not.toContain('bypass')
    expect(lower).not.toContain('deny')
    expect(lower).not.toContain('block')
  })
})
