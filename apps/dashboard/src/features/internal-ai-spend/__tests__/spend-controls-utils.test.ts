/**
 * Node-env unit tests (no RTL, no jsdom) for the Spend Controls pure helpers
 *These assert the generated copy strings and the pace/coverage/
 * ceiling math directly — the logic lives in pure functions precisely so it can
 * be tested without mounting a React component.
 */
import {
  alertRecipientsLine,
  buildCapSentence,
  toolCoverageLine,
  COVERAGE_CHECK_SCOPE_NOTE,
  COVERAGE_CODEX_SCOPE_NOTE,
  COVERAGE_NO_ACTIVITY_LINE,
  COVERAGE_ROSTER_NOTE,
  COVERAGE_SEPARATE_COUNTS_NOTE,
  COVERAGE_UNKNOWN_NOTE,
  projectPace,
  paceCopy,
  checkAmountAgainstCeiling,
  pickApplicableCeiling,
  MODE_COPY,
  freshnessLabel,
  providerLabel,
} from '../spend-controls-utils'

describe('buildCapSentence', () => {
  it('assembles the labeled-bet sentence for a per-dev weekly cap', () => {
    expect(
      buildCapSentence({
        providerScope: 'anthropic',
        amountUsd: 200,
        scope: 'dev',
        scopeValue: 'alice@acme.example',
        period: 'week',
      })
    ).toBe('Stop Claude spend at $200 for alice@acme.example per week')
  })

  it('renders an org ceiling as an across-the-team monthly sentence with thousands separators', () => {
    expect(
      buildCapSentence({
        providerScope: 'all',
        amountUsd: 5000,
        scope: 'org',
        scopeValue: null,
        period: 'month',
      })
    ).toBe('Stop AI spend at $5,000 across the whole team per month')
  })

  it('falls back to the raw provider string for an unknown provider', () => {
    expect(providerLabel('mistral')).toBe('mistral')
  })

  it('says "per teammate" when a dev cap has no target picked yet', () => {
    expect(
      buildCapSentence({
        providerScope: 'all',
        amountUsd: 200,
        scope: 'dev',
        scopeValue: null,
        period: 'week',
      })
    ).toBe('Stop AI spend at $200 per teammate per week')
  })
})

// These are exact-string assertions on purpose: a loosely-matched test
// would let an overclaim back in.
describe('toolCoverageLine', () => {
  const counts = (
    armed: number,
    notArmed: number,
    unknown: number,
    total: number
  ) => ({ armed, notArmed, unknown, total })

  it('says plainly when nobody used the tool in the window', () => {
    expect(toolCoverageLine('Codex', counts(0, 0, 0, 0))).toBe(
      "Codex: nobody's used it in the last 7 days."
    )
    expect(toolCoverageLine('Claude Code', counts(0, 0, 0, 0))).toBe(
      "Claude Code: nobody's used it in the last 7 days."
    )
  })

  it('names the tool and its own denominator when everyone is accounted for', () => {
    expect(toolCoverageLine('Claude Code', counts(12, 2, 0, 14))).toBe(
      "Claude Code: 12 of 14 teammates who used it in the last 7 days have the cap check running on every machine we've seen."
    )
  })

  it('adds the cannot-tell tail when some machines cannot be vouched for', () => {
    expect(toolCoverageLine('Codex', counts(3, 1, 1, 5))).toBe(
      "Codex: 3 of 5 teammates who used it in the last 7 days have the cap check running on every machine we've seen. We can't tell for 1 of those 5."
    )
  })

  it('keeps the tail count plural-agnostic (it is a count, not a noun)', () => {
    expect(toolCoverageLine('Codex', counts(3, 0, 2, 5))).toContain(
      "We can't tell for 2 of those 5."
    )
  })

  // The unknown-heavy org: an all-old-meter fleet. It must NOT read as a clean
  // "0 of 4 covered", which an admin scans as a known gap rather than a blind spot.
  it('never claims a covered count when every machine is unknown', () => {
    expect(toolCoverageLine('Codex', counts(0, 0, 4, 4))).toBe(
      "Codex: 4 teammates used it in the last 7 days, and we can't tell whether the cap check is running for any of them."
    )
  })

  it('uses the singular when the one machine we saw is unknown', () => {
    expect(toolCoverageLine('Codex', counts(0, 0, 1, 1))).toBe(
      "Codex: 1 teammate used it in the last 7 days, and we can't tell whether the cap check is running for them."
    )
  })

  it('uses the singular teammate and verb for a one-person one-tool org', () => {
    expect(toolCoverageLine('Claude Code', counts(1, 0, 0, 1))).toBe(
      "Claude Code: 1 of 1 teammate who used it in the last 7 days has the cap check running on every machine we've seen."
    )
  })

  it('matches the verb to the covered count, not the denominator', () => {
    expect(toolCoverageLine('Codex', counts(1, 1, 0, 2))).toContain(
      '1 of 2 teammates who used it in the last 7 days has the cap check running'
    )
  })

  it('renders a fully uncovered but fully known tool from the standard template', () => {
    expect(toolCoverageLine('Codex', counts(0, 9, 0, 9))).toBe(
      "Codex: 0 of 9 teammates who used it in the last 7 days have the cap check running on every machine we've seen."
    )
  })

  it('clamps a late stamp so the covered count never exceeds the denominator', () => {
    expect(toolCoverageLine('Claude Code', counts(18, 0, 0, 17))).toContain(
      '17 of 17 teammates'
    )
  })

  it('clamps toward "we cannot tell", never toward a coverage claim', () => {
    // Bad data: 2 covered and 5 unknown out of 5. The buckets over-fill, so one
    // of them has to give. Covered gives way, because the wrong answer a reader
    // can act on safely is "we don't know", not an invented fraction.
    expect(toolCoverageLine('Codex', counts(2, 0, 5, 5))).toBe(
      "Codex: 5 teammates used it in the last 7 days, and we can't tell whether the cap check is running for any of them."
    )
  })

  it('admin-facing lines use no implementation terms', () => {
    const everyState = [
      toolCoverageLine('Claude Code', counts(0, 0, 0, 0)),
      toolCoverageLine('Claude Code', counts(12, 2, 0, 14)),
      toolCoverageLine('Codex', counts(3, 1, 1, 5)),
      toolCoverageLine('Codex', counts(0, 0, 4, 4)),
      COVERAGE_NO_ACTIVITY_LINE,
      COVERAGE_SEPARATE_COUNTS_NOTE,
      COVERAGE_UNKNOWN_NOTE,
      COVERAGE_CHECK_SCOPE_NOTE,
      COVERAGE_CODEX_SCOPE_NOTE,
      COVERAGE_ROSTER_NOTE,
    ]
      .join(' ')
      .toLowerCase()
    for (const jargon of ['armed', 'stamp', 'hook', 'trust status', '0.12']) {
      expect(everyState).not.toContain(jargon)
    }
  })
})

describe('coverage explainer copy', () => {
  it('says the two lines do not add up, before an admin adds them', () => {
    expect(COVERAGE_SEPARATE_COUNTS_NOTE).toBe(
      "The two lines count separately. Someone who uses both tools shows up in both, so the numbers won't add up to your team size."
    )
  })

  // The whole old-meter rule, written for a human: an unknown machine
  // is never a covered machine, and the copy has to say so out loud.
  it('states plainly that an unknown machine does not count as covered', () => {
    expect(COVERAGE_UNKNOWN_NOTE).toBe(
      "We can't always tell. It happens when a machine is running an older version of the meter, when Codex didn't answer us about that machine, or when we've seen someone's activity but nothing that tells us how their machine is set up. We count none of those as protected."
    )
  })

  // "We can't tell when X" parses first as "we can't tell AT WHAT TIME X", which
  // costs a second pass on the one sentence that has to land first time.
  it('does not open with a clause that parses as a time question', () => {
    expect(COVERAGE_UNKNOWN_NOTE).not.toMatch(/^We can't tell when\b/)
  })

  // One vocabulary, not two. Every other line says "the cap check running"; a
  // stray "covered" makes the reader map the two onto each other.
  it('uses the same words as the tool lines, never a second vocabulary', () => {
    const everySentence = [
      COVERAGE_UNKNOWN_NOTE,
      COVERAGE_SEPARATE_COUNTS_NOTE,
      COVERAGE_CHECK_SCOPE_NOTE,
      COVERAGE_ROSTER_NOTE,
      COVERAGE_CODEX_SCOPE_NOTE,
    ].join(' ')
    expect(everySentence).not.toMatch(/\bcovered\b/i)
  })

  // Coverage folds by git email, so two machines under one email are ONE entry, taken at
  // the weakest machine. A reader who thinks the counts are padded by extra
  // machines discounts a real gap.
  it('describes the git-email fold the way the math actually works', () => {
    expect(COVERAGE_ROSTER_NOTE).toContain(
      'We tell people apart by the email their code is signed with'
    )
    expect(COVERAGE_ROSTER_NOTE).toContain('least protected')
    expect(COVERAGE_ROSTER_NOTE).not.toMatch(
      /show up more than once if they code from more than one machine/
    )
  })

  // Arming is a hook receipt. It is true with zero caps set, and true for a cap
  // that only watches. The caps live on a different subtab, so nothing else on
  // screen corrects a reader who takes the line as "spend is capped".
  it('separates the check from the caps, and names track mode', () => {
    expect(COVERAGE_CHECK_SCOPE_NOTE).toContain('not your caps')
    expect(COVERAGE_CHECK_SCOPE_NOTE).toContain("haven't set a cap at all")
    expect(COVERAGE_CHECK_SCOPE_NOTE).toContain('only watches and warns')
  })

  it('says what the Codex answer covers, and what it does not', () => {
    expect(COVERAGE_CODEX_SCOPE_NOTE).toContain("each machine's main setup")
    expect(COVERAGE_CODEX_SCOPE_NOTE).toContain("we won't see it")
  })

  it('keeps the no-activity line reading as the meter, not the Users tab', () => {
    expect(COVERAGE_NO_ACTIVITY_LINE).toBe(
      "The meter hasn't seen anyone coding in the last 7 days."
    )
  })
})

describe('projectPace', () => {
  // A week window: Mon 00:00 UTC -> next Mon 00:00 UTC.
  const windowStartMs = Date.UTC(2026, 6, 20, 0, 0, 0) // Mon 2026-07-20
  const windowEndMs = Date.UTC(2026, 6, 27, 0, 0, 0) // Mon 2026-07-27

  it('flags reached when spend is at or over the cap', () => {
    expect(
      projectPace({
        spentUsd: 200,
        amountUsd: 200,
        windowStartMs,
        windowEndMs,
        nowMs: Date.UTC(2026, 6, 22),
      }).status
    ).toBe('reached')
  })

  it('projects the crossing weekday from a known burn rate', () => {
    // $100 spent across 2 elapsed days -> $50/day; a $200 cap is hit at day 4
    // from Monday start = Friday 00:00 UTC.
    const now = Date.UTC(2026, 6, 22, 0, 0, 0) // Wed (2 days in)
    const pace = projectPace({
      spentUsd: 100,
      amountUsd: 200,
      windowStartMs,
      windowEndMs,
      nowMs: now,
    })
    expect(pace.status).toBe('projected')
    expect(pace.weekday).toBe('Friday')
    expect(paceCopy(pace)).toBe('On track to hit the cap ~Friday (estimate).')
  })

  it('reports under-pace when the projected crossing lands after the window', () => {
    // $5 over 2 days -> $2.50/day; a $200 cap would take 80 days, well past the
    // 7-day window.
    expect(
      projectPace({
        spentUsd: 5,
        amountUsd: 200,
        windowStartMs,
        windowEndMs,
        nowMs: Date.UTC(2026, 6, 22),
      }).status
    ).toBe('under-pace')
  })

  it('returns unknown (never $0-projects) when there is no priced spend yet', () => {
    expect(
      projectPace({
        spentUsd: null,
        amountUsd: 200,
        windowStartMs,
        windowEndMs,
        nowMs: Date.UTC(2026, 6, 22),
      }).status
    ).toBe('unknown')
  })
})

describe('checkAmountAgainstCeiling', () => {
  it('rejects a child cap above the org ceiling with the ceiling in the message', () => {
    const r = checkAmountAgainstCeiling(300, 200)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('$200 org ceiling')
    expect(r.message).toContain("A teammate cap can't be higher")
  })

  it('allows a child cap at or below the ceiling', () => {
    expect(checkAmountAgainstCeiling(200, 200).ok).toBe(true)
    expect(checkAmountAgainstCeiling(150, 200).ok).toBe(true)
  })

  it('has nothing to violate when no ceiling applies', () => {
    expect(checkAmountAgainstCeiling(999999, null).ok).toBe(true)
  })
})

describe('pickApplicableCeiling', () => {
  const ceilings = [
    { providerScope: 'all', amountUsd: 500 },
    { providerScope: 'anthropic', amountUsd: 200 },
  ]
  it('prefers the same-provider ceiling', () => {
    expect(pickApplicableCeiling('anthropic', ceilings)).toBe(200)
  })
  it('falls back to the all ceiling for an unlisted provider', () => {
    expect(pickApplicableCeiling('openai', ceilings)).toBe(500)
  })
  it('does not let the all fallback apply to an all-scoped child (nothing above all)', () => {
    expect(
      pickApplicableCeiling('all', [
        { providerScope: 'anthropic', amountUsd: 200 },
      ])
    ).toBeNull()
  })
  it('returns null when there are no ceilings', () => {
    expect(pickApplicableCeiling('openai', [])).toBeNull()
  })
})

describe('MODE_COPY — track never claims it stops anything', () => {
  it('track copy contains no stop/block/prevent/halt language', () => {
    const track =
      `${MODE_COPY.track.label} ${MODE_COPY.track.tagline} ${MODE_COPY.track.atCap}`.toLowerCase()
    expect(track).not.toContain('stop')
    expect(track).not.toContain('block')
    expect(track).not.toContain('prevent')
    expect(track).not.toContain('halt')
  })

  it('track explicitly disclaims enforcement at the cap', () => {
    expect(MODE_COPY.track.atCap).toContain('notification, not enforcement')
  })

  it('enforce copy is the one that names a real stop', () => {
    expect(MODE_COPY.enforce.atCap.toLowerCase()).toContain('stopped')
  })

  it('enforce copy names Claude Code and Codex (the both-tools truth)', () => {
    expect(MODE_COPY.enforce.tagline).toContain('Claude Code and Codex')
    expect(MODE_COPY.enforce.atCap).toContain('Claude Code and Codex')
  })

  // Guard-safe vocabulary: dashboard copy says pause/stop, never block.
  it('no MODE_COPY string says "block"', () => {
    for (const mode of ['track', 'enforce'] as const) {
      const all =
        `${MODE_COPY[mode].label} ${MODE_COPY[mode].tagline} ${MODE_COPY[mode].atCap}`.toLowerCase()
      expect(all).not.toContain('block')
    }
  })
})

describe('freshnessLabel', () => {
  const now = Date.UTC(2026, 6, 22, 12, 0, 0)
  it('renders minutes-ago', () => {
    expect(freshnessLabel(now - 12 * 60 * 1000, now)).toBe(
      'as of 12 minutes ago'
    )
  })
  it('renders the singular minute', () => {
    expect(freshnessLabel(now - 60 * 1000, now)).toBe('as of 1 minute ago')
  })
  it('renders hours-ago', () => {
    expect(freshnessLabel(now - 3 * 60 * 60 * 1000, now)).toBe(
      'as of 3 hours ago'
    )
  })
  it('never invents a time when asOf is unknown', () => {
    expect(freshnessLabel(null, now)).toBe('freshness unknown')
  })
})

describe('alertRecipientsLine — where cap alerts go', () => {
  it('names the billing email when one is set', () => {
    expect(
      alertRecipientsLine({
        billingEmail: 'billing@acme.example',
        fallbackCount: 2,
      })
    ).toBe('Alerts go to billing@acme.example.')
  })

  it('falls back to owner and finance teammates when no billing email is set', () => {
    expect(alertRecipientsLine({ billingEmail: null, fallbackCount: 2 })).toBe(
      'Alerts go to your owner and finance teammates. Set a billing email in Settings to change this.'
    )
  })

  it("says plainly when alerts can't reach anyone", () => {
    expect(alertRecipientsLine({ billingEmail: null, fallbackCount: 0 })).toBe(
      "Alerts can't reach anyone yet. Add a billing email in Settings so someone gets them."
    )
  })
})
