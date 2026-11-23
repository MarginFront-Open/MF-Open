/**
 * The copy style gate: zero em/en dashes and zero uncontracted forms in
 * every exported user-facing copy string.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  MODE_COPY,
  alertRecipientsLine,
  paceCopy,
  checkAmountAgainstCeiling,
  toolCoverageLine,
  CAP_NO_BAR_PROVIDER,
  CAP_NO_BAR_TEAM,
  COVERAGE_CHECK_SCOPE_NOTE,
  COVERAGE_CODEX_SCOPE_NOTE,
  COVERAGE_NO_ACTIVITY_LINE,
  COVERAGE_ROSTER_NOTE,
  COVERAGE_SEPARATE_COUNTS_NOTE,
  COVERAGE_UNKNOWN_NOTE,
  freshnessLabel,
  buildCapSentence,
} from '../spend-controls-utils'
import {
  buildCaplessInstallKit,
  buildInstallKit,
  formatKitPlainText,
  ADMIN_SEND_CHECKLIST,
  CAPLESS_PATH_B_PROMPT_TEMPLATE,
  CAPS_LATER_NOTE,
  PATH_B_PROMPT_TEMPLATE,
  ARMING_LINE,
  SUPPORT_NOTE,
  WINDOWS_WSL_NOTE,
} from '../install-kit'
import {
  REPO_HELP_AFTER,
  REPO_HELP_COPIED_LABEL,
  REPO_HELP_COPY_LABEL,
  REPO_HELP_INTRO,
  REPO_HELP_PROMPT,
  REPO_HELP_PROMPT_LABEL,
  REPO_HELP_TOGGLE,
} from '../repo-help'
import {
  BREAKDOWN_COLUMN_HEADERS,
  DIMENSION_CHOICES,
  DRILL_CAVEAT_NOTE,
  DRILL_COLLAPSE_LABEL,
  DRILL_COLUMN_HEADERS,
  DRILL_EMPTY_LINE,
  DRILL_ERROR_LINE,
  DRILL_EXPAND_LABEL,
  EMPTY_NO_ACTIVITY,
  EXPORT_CSV_LABEL,
  NO_COMMIT_RECORDED,
  NO_KEY_LABELS,
  NO_KEY_ROW_NOTES,
  PERIOD_CHOICES,
  REPO_SPEND_ERROR_LINE,
  REPO_SPEND_EXPLAINER_COVERAGE,
  REPO_SPEND_EXPLAINER_HOW,
  REPO_SPEND_EXPLAINER_PR,
  REPO_SPEND_EXPLAINER_TITLE,
  REPO_SPEND_INTRO,
  REPO_SPEND_PERIOD_NOTE,
  REPO_SPEND_TITLE,
  coverageLine,
  noTaggedLine,
  spendCellText,
  totalsLine,
} from '@/features/money/repo-spend'

const EM_OR_EN_DASH = /[—–]/
// The contraction list, as word-boundary patterns. "let us" is
// deliberately absent (the "let us know" guard).
const UNCONTRACTED = [
  /\bdo not\b/i,
  /\bdoes not\b/i,
  /\bdid not\b/i,
  /\bcannot\b/i,
  /\bwill not\b/i,
  /\bwould not\b/i,
  /\bshould not\b/i,
  /\bcould not\b/i,
  /\bis not\b/i,
  /\bare not\b/i,
  /\bwas not\b/i,
  /\bwere not\b/i,
  /\bhave not\b/i,
  /\bhas not\b/i,
  /\bhad not\b/i,
  /\bit is\b/i,
  /\byou are\b/i,
  /\bwe are\b/i,
  /\bthey are\b/i,
]

function assertClean(label: string, text: string): void {
  expect(`${label}: ${text}`).not.toMatch(EM_OR_EN_DASH)
  for (const form of UNCONTRACTED) {
    expect(`${label}: ${text}`).not.toMatch(form)
  }
}

describe('copy style gate: spend-controls copy constants', () => {
  it('MODE_COPY carries no em dashes or uncontracted forms', () => {
    for (const mode of ['track', 'enforce'] as const) {
      const c = MODE_COPY[mode]
      assertClean(`${mode}.label`, c.label)
      assertClean(`${mode}.tagline`, c.tagline)
      assertClean(`${mode}.atCap`, c.atCap)
    }
  })

  it('pace copy is clean in every state', () => {
    for (const status of [
      'reached',
      'projected',
      'under-pace',
      'unknown',
    ] as const) {
      assertClean(status, paceCopy({ status, weekday: 'Thursday' }))
    }
  })

  it('ceiling and coverage copy is clean', () => {
    assertClean('ceiling', checkAmountAgainstCeiling(300, 200).message ?? '')
    assertClean('coverage-empty', COVERAGE_NO_ACTIVITY_LINE)
    assertClean('coverage-roster', COVERAGE_ROSTER_NOTE)
    assertClean('coverage-separate', COVERAGE_SEPARATE_COUNTS_NOTE)
    assertClean('coverage-check-scope', COVERAGE_CHECK_SCOPE_NOTE)
    assertClean('coverage-unknown-note', COVERAGE_UNKNOWN_NOTE)
    assertClean('coverage-codex-scope', COVERAGE_CODEX_SCOPE_NOTE)
    assertClean('cap-no-bar-team', CAP_NO_BAR_TEAM)
    assertClean('cap-no-bar-provider', CAP_NO_BAR_PROVIDER)
    assertClean('freshness-unknown', freshnessLabel(null, 0))
  })

  // Includes the two per-tool edge states: some machines we cannot vouch
  // for, and none we can.
  it('every per-tool coverage state is clean, for both tools', () => {
    const states: ReadonlyArray<
      [
        string,
        { armed: number; notArmed: number; unknown: number; total: number },
      ]
    > = [
      ['no-activity', { armed: 0, notArmed: 0, unknown: 0, total: 0 }],
      ['all-covered', { armed: 6, notArmed: 0, unknown: 0, total: 6 }],
      ['none-covered', { armed: 0, notArmed: 9, unknown: 0, total: 9 }],
      ['singular', { armed: 1, notArmed: 0, unknown: 0, total: 1 }],
      ['some-unknown', { armed: 3, notArmed: 1, unknown: 1, total: 5 }],
      ['all-unknown', { armed: 0, notArmed: 0, unknown: 4, total: 4 }],
      ['all-unknown-singular', { armed: 0, notArmed: 0, unknown: 1, total: 1 }],
    ]
    for (const tool of ['Claude Code', 'Codex'] as const) {
      for (const [label, counts] of states) {
        assertClean(`${tool}.${label}`, toolCoverageLine(tool, counts))
      }
    }
  })

  it('the alerts-destination line is clean in every state', () => {
    assertClean(
      'alerts-billing-email',
      alertRecipientsLine({
        billingEmail: 'billing@acme.example',
        fallbackCount: 0,
      })
    )
    assertClean(
      'alerts-fallback',
      alertRecipientsLine({ billingEmail: null, fallbackCount: 2 })
    )
    assertClean(
      'alerts-nobody',
      alertRecipientsLine({ billingEmail: null, fallbackCount: 0 })
    )
  })
})

/**
 * Every gate above reads an exported constant, so this one checks copy typed
 * straight into JSX. Comments are stripped first (they are not for the
 * reader) and what is left is the rendered surface.
 */
describe('copy style gate: copy typed inline into the Internal AI Spend JSX', () => {
  const SOURCES = ['index.tsx', 'components/install-kit-dialog.tsx'] as const

  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  for (const relative of SOURCES) {
    it(`${relative} renders no em or en dashes`, () => {
      const source = withoutComments(
        readFileSync(join(__dirname, '..', relative), 'utf8')
      )
      const offenders = source
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => EM_OR_EN_DASH.test(line))
      expect(offenders).toEqual([])
    })
  }

  it('bites: the gate catches a line with a dash', () => {
    // Negative control. If this ever stops matching, the check above is inert.
    const lineWithDash =
      "so there's no bar for this cap — it's saved and tracked."
    expect(withoutComments(`<p>${lineWithDash}</p>`)).toMatch(EM_OR_EN_DASH)
  })
})

describe('copy style gate: install-kit copy', () => {
  const kit = buildInstallKit({
    orgName: 'Acme',
    capSentence: buildCapSentence({
      providerScope: 'all',
      amountUsd: 5000,
      scope: 'org',
      scopeValue: null,
      period: 'month',
    }),
    mode: 'enforce',
    whyNote: 'We went over budget last month.',
    setterName: 'Jordan Lee',
  })

  it('the whole rendered kit (both modes) is clean', () => {
    assertClean('kit-enforce', formatKitPlainText(kit))
    const trackKit = buildInstallKit({
      orgName: 'Acme',
      capSentence: 'Track AI spend against $200 per week',
      mode: 'track',
      whyNote: '',
      setterName: 'Jordan Lee',
    })
    assertClean('kit-track', formatKitPlainText(trackKit))
  })

  it('the pinned constants are clean', () => {
    assertClean('PATH_B_PROMPT_TEMPLATE', PATH_B_PROMPT_TEMPLATE)
    assertClean('ARMING_LINE', ARMING_LINE)
    assertClean('SUPPORT_NOTE', SUPPORT_NOTE)
    assertClean(
      'CAPLESS_PATH_B_PROMPT_TEMPLATE',
      CAPLESS_PATH_B_PROMPT_TEMPLATE
    )
    assertClean('CAPS_LATER_NOTE', CAPS_LATER_NOTE)
    assertClean('WINDOWS_WSL_NOTE', WINDOWS_WSL_NOTE)
  })

  it('the capless kit is clean end to end', () => {
    const capless = buildCaplessInstallKit({
      orgName: 'Acme',
      setterName: 'Jordan Lee',
    })
    assertClean('kit-capless', formatKitPlainText(capless))
  })

  it('the on-screen admin checklist is clean too', () => {
    assertClean('ADMIN_SEND_CHECKLIST.heading', ADMIN_SEND_CHECKLIST.heading)
    for (const [i, line] of ADMIN_SEND_CHECKLIST.lines.entries()) {
      assertClean(`ADMIN_SEND_CHECKLIST.lines[${i}]`, line)
    }
  })
})

describe('copy style gate: repo-spend copy', () => {
  it('the pinned constants are clean', () => {
    assertClean('REPO_SPEND_TITLE', REPO_SPEND_TITLE)
    assertClean('REPO_SPEND_INTRO', REPO_SPEND_INTRO)
    assertClean('REPO_SPEND_PERIOD_NOTE', REPO_SPEND_PERIOD_NOTE)
    assertClean('REPO_SPEND_ERROR_LINE', REPO_SPEND_ERROR_LINE)
    assertClean('EMPTY_NO_ACTIVITY', EMPTY_NO_ACTIVITY)
    assertClean('EXPORT_CSV_LABEL', EXPORT_CSV_LABEL)
    for (const [dim, label] of Object.entries(NO_KEY_LABELS)) {
      assertClean(`NO_KEY_LABELS.${dim}`, label)
    }
    for (const choice of DIMENSION_CHOICES) {
      assertClean(`dimension.${choice.id}`, choice.label)
      assertClean(`dimension.${choice.id}.column`, choice.columnHeader)
    }
    for (const choice of PERIOD_CHOICES) {
      assertClean(`period.${choice.id}`, choice.label)
    }
    for (const [key, header] of Object.entries(BREAKDOWN_COLUMN_HEADERS)) {
      assertClean(`column.${key}`, header)
    }
  })

  it('every state of the generated lines is clean', () => {
    for (const dim of ['repo', 'branch'] as const) {
      assertClean(`coverage-partial.${dim}`, coverageLine(83.3, dim))
      assertClean(`coverage-full.${dim}`, coverageLine(100, dim))
      assertClean(`no-tagged.${dim}`, noTaggedLine(dim))
    }
    assertClean('spend-null', spendCellText(null))
    assertClean(
      'totals-priced',
      totalsLine({ spentUsd: 12.5, eventCount: 3, unpricedEventCount: 0 })
    )
    assertClean(
      'totals-null',
      totalsLine({ spentUsd: null, eventCount: 3, unpricedEventCount: 3 })
    )
  })
})

describe('copy style gate: repo-spend title explainer', () => {
  const EXPLAINER = {
    REPO_SPEND_EXPLAINER_TITLE,
    REPO_SPEND_EXPLAINER_HOW,
    REPO_SPEND_EXPLAINER_PR,
    REPO_SPEND_EXPLAINER_COVERAGE,
  }

  it('every explainer string exists, has content, and is clean', () => {
    for (const [label, text] of Object.entries(EXPLAINER)) {
      expect(typeof text).toBe('string')
      expect((text as string).length).toBeGreaterThan(0)
      assertClean(label, text as string)
    }
  })

  it('stays a short explainer, not an essay', () => {
    const body = [
      REPO_SPEND_EXPLAINER_HOW,
      REPO_SPEND_EXPLAINER_PR,
      REPO_SPEND_EXPLAINER_COVERAGE,
    ].join(' ')
    const sentences = body.split(/[.!?](?:\s|$)/).filter((s) => s.trim())
    expect(sentences.length).toBeLessThanOrEqual(7)
    expect(body.length).toBeLessThanOrEqual(1000)
  })

  it('keeps the honest two-way caveat on the branch-as-PR claim', () => {
    expect(REPO_SPEND_EXPLAINER_PR).toMatch(/before the branch was created/i)
    // The meter stamps whatever branch was checked out at flush time, which
    // is often main but not always: a flat "lands under main" overclaims.
    expect(REPO_SPEND_EXPLAINER_PR).toMatch(/whichever branch was checked out/i)
    expect(REPO_SPEND_EXPLAINER_PR).toMatch(/\bmain\b/)
    // Both error directions must be named. Calling it only a "floor" would be
    // false: one branch bucket can span several PRs (reused/long-lived
    // branch names, the main row), where the number OVER-counts a single PR.
    expect(REPO_SPEND_EXPLAINER_PR).toMatch(/several pull requests/i)
    expect(REPO_SPEND_EXPLAINER_PR).toMatch(/not an exact/i)
    expect(REPO_SPEND_EXPLAINER_PR).not.toMatch(/\bfloor\b/i)
  })

  it('names the untagged bucket the same way the table does', () => {
    expect(REPO_SPEND_EXPLAINER_COVERAGE).toContain(NO_KEY_LABELS.repo)
    expect(REPO_SPEND_EXPLAINER_COVERAGE).toContain(NO_KEY_LABELS.branch)
  })
})

describe('copy style gate: branch drill copy', () => {
  it('the pinned drill constants are clean', () => {
    assertClean('NO_COMMIT_RECORDED', NO_COMMIT_RECORDED)
    assertClean('DRILL_EXPAND_LABEL', DRILL_EXPAND_LABEL)
    assertClean('DRILL_COLLAPSE_LABEL', DRILL_COLLAPSE_LABEL)
    assertClean('DRILL_ERROR_LINE', DRILL_ERROR_LINE)
    assertClean('DRILL_EMPTY_LINE', DRILL_EMPTY_LINE)
    assertClean('DRILL_CAVEAT_NOTE', DRILL_CAVEAT_NOTE)
    for (const [key, header] of Object.entries(DRILL_COLUMN_HEADERS)) {
      assertClean(`drill-column.${key}`, header)
    }
  })
})

describe('copy style gate: the repo-missing helper (repo-help.ts)', () => {
  it('every pinned helper string is clean, the whole prompt included', () => {
    assertClean('REPO_HELP_TOGGLE', REPO_HELP_TOGGLE)
    assertClean('REPO_HELP_INTRO', REPO_HELP_INTRO)
    assertClean('REPO_HELP_PROMPT_LABEL', REPO_HELP_PROMPT_LABEL)
    assertClean('REPO_HELP_COPY_LABEL', REPO_HELP_COPY_LABEL)
    assertClean('REPO_HELP_COPIED_LABEL', REPO_HELP_COPIED_LABEL)
    assertClean('REPO_HELP_AFTER', REPO_HELP_AFTER)
    assertClean('REPO_HELP_PROMPT', REPO_HELP_PROMPT)
  })

  it('the no-key row notes are clean in both dimensions', () => {
    for (const [dim, note] of Object.entries(NO_KEY_ROW_NOTES)) {
      assertClean(`NO_KEY_ROW_NOTES.${dim}`, note)
    }
  })
})
