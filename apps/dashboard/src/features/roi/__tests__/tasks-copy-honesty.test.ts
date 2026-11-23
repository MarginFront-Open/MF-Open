/**
 * WHAT THIS FILE DOES: pins two copy rules. First, no
 * user-facing label whose value is a usage-event count may call that count a
 * "task". Second, the Matters surface reads for every org, not only for law
 * firms: its nav entry, page heading and subtitle carry none of "law", "firm"
 * or "case".
 *
 * WHY IT EXISTS: a usage event is one call an integration records, and for the
 * coding meter it is one model response plus one per tool per five-minute
 * flush. Calling that a task would tell a customer with 1,962 events that
 * their agents finished 1,962 jobs.
 *
 * Source-asserted (readFileSync) because the jest environment here is
 * node-only: there is no React Testing Library to render these components with.
 *
 * CONNECTS TO: every path in EVENT_COUNT_COPY_FILES and MATTERS_FACE_FILES.
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  SCOPE_HELPER_COPY,
  SCOPE_SUMMARY_COPY,
  matterScopeLabel,
} from '../progress-derivation'
import {
  DEAD_PAGE_NAME,
  LAYOUT_DIRECTION,
  MOVES_THE_READER,
  SURFACE_WORD,
  VERTICAL_WORD,
} from './support/copy-gates'

const DASHBOARD_ROOT = join(__dirname, '..', '..', '..', '..')

function read(relativePath: string): string {
  return readFileSync(join(DASHBOARD_ROOT, relativePath), 'utf8')
}

/** Comments are not copy. Leaves `https://` intact by refusing to treat `//`
 * as a comment opener when a colon or slash precedes it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
}

type CopyFragment = { text: string; kind: 'quoted' | 'jsx' }

/**
 * Every quoted literal (and, for a .tsx file, every JSX text node) outside the
 * comments. Single lowercase words are dropped: those are identifiers and
 * union members such as 'tasks', 'count' and 'cost+revenue', which stay as
 * they are. Renaming them would be a refactor, not a copy fix.
 *
 * Each fragment carries where it came from, because the two kinds cannot be
 * filtered the same way: see looksLikeCode.
 */
function displayCopy(
  source: string,
  options: { jsx: boolean }
): CopyFragment[] {
  const code = stripComments(source)
  const quoted = (code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []).map(
    (text): CopyFragment => ({ text, kind: 'quoted' })
  )
  const jsxText = options.jsx
    ? (code.match(/>[^<>{}]+</g) ?? []).map(
        (text): CopyFragment => ({ text, kind: 'jsx' })
      )
    : []
  return [...quoted, ...jsxText]
    .map((fragment) => ({
      ...fragment,
      text: fragment.text.slice(1, -1).trim(),
    }))
    .filter((fragment) => fragment.text.length > 0)
    .filter((fragment) => !/^[a-z0-9+_.-]+$/.test(fragment.text))
}

const TASK_WORD = /\btasks?\b/i
const LAW_WORD = /\b(law|laws|firm|firms|case|cases)\b/i

/**
 * Files where EVERY piece of display copy is about the usage-event count, so
 * the whole file is scanned. Files that also carry a legitimate task word live
 * in their own scoped tests below.
 */
const EVENT_COUNT_COPY_FILES: Array<[string, { jsx: boolean }]> = [
  ['src/features/roi/progress-derivation.ts', { jsx: false }],
  ['src/features/roi/components/without-ai.tsx', { jsx: true }],
  ['src/features/roi/components/initiative-dialog.tsx', { jsx: true }],
  // The report above the goals and its pure copy module.
  ['src/features/roi/report-derivation.ts', { jsx: false }],
  ['src/features/roi/components/roi-report.tsx', { jsx: true }],
  ['src/features/dashboard-shell/chart-metric.ts', { jsx: false }],
  ['src/features/dashboard-shell/tiles/breakdown-table.tsx', { jsx: true }],
  ['src/features/build/components/agents-table.tsx', { jsx: true }],
  ['src/features/money/components/csv-columns.ts', { jsx: false }],
  ['app/(customer-portal)/portal/[slug]/(main)/page.tsx', { jsx: true }],
  [
    'app/(customer-portal)/portal/[slug]/(main)/_components/PortalActivityChart.tsx',
    { jsx: true },
  ],
]

describe('no user-facing label calls a usage-event count a task', () => {
  it.each(EVENT_COUNT_COPY_FILES)(
    '%s has no task word in its display copy',
    (path, options) => {
      const offenders = displayCopy(read(path), options)
        .map((fragment) => fragment.text)
        .filter((text) => TASK_WORD.test(text))
      expect(offenders).toEqual([])
    }
  )

  // Keyed on the entry rather than on one printed line: the registry gained a
  // third field per metric, and prettier wraps a long entry onto four lines.
  it('the ROI metric registry labels the count "Usage events" and its average per usage event', () => {
    const source = read('src/features/roi/progress-derivation.ts')
    expect(source).toMatch(/eventCount:\s*\{\s*label: 'Usage events'/)
    expect(source).toMatch(
      /costPerTask:\s*\{\s*label: 'Avg cost \/ usage event'/
    )
  })

  it('the KPI tile registry labels the same two metrics the same way', () => {
    const source = read('src/lib/component-catalog.ts')
    const labels = [...source.matchAll(/\blabel: '([^']*)'/g)].map((m) => m[1])
    expect(labels.length).toBeGreaterThan(10)
    expect(labels.filter((label) => TASK_WORD.test(label))).toEqual([])
    expect(labels).toContain('Usage events')
    expect(labels).toContain('Avg cost / usage event')
  })

  it('the breakdown dimension named for signals keeps the word Task on purpose', () => {
    // The Task dimension groups events by signal name, so its rows really are
    // tasks the customer named. Only counts were mislabelled, never this.
    expect(read('src/lib/component-catalog.ts')).toContain("signal: 'Task'")
  })

  it('the shared metric registry says what one usage event is, for both sources', () => {
    // METRIC_DESCRIPTIONS lives in report-derivation.ts: the dialog, the
    // report tiles and the print all render these sentences, so there is one
    // copy.
    const source = read('src/features/roi/report-derivation.ts')
    const descriptions = source.slice(
      source.indexOf('export const METRIC_DESCRIPTIONS'),
      source.indexOf('export const REPORT_COPY')
    )
    expect(descriptions).not.toMatch(TASK_WORD)
    // The definition itself lives in REPORT_COPY, once, as the
    // agents-section note, not again inside the Usage events tile.
    const copyStart = source.indexOf('export const REPORT_COPY')
    const reportCopy = source.slice(
      copyStart,
      source.indexOf('\n} as const', copyStart)
    )
    expect(reportCopy).not.toMatch(TASK_WORD)
    expect(reportCopy).toMatch(/one call your integration records/)
    expect(reportCopy).toMatch(/five-minute flush/)
  })

  it('the dialog reads that one registry rather than keeping its own copy', () => {
    const source = read('src/features/roi/components/initiative-dialog.tsx')
    expect(source).toMatch(
      /import \{[^}]*\bMETRIC_DESCRIPTIONS\b[^}]*\} from '\.\.\/report-derivation'/s
    )
    expect(source).not.toMatch(/const METRIC_DESCRIPTIONS/)
  })

  it('the agent-strip tooltips describe the count without the task word', () => {
    // tooltip-definitions.ts as a whole legitimately says "task": the
    // breakdown Task dimension groups events by signal name. Only these two
    // entries describe the eventCount the agents table calls "Usage
    // events", so only these two are scanned.
    const source = read('lib/tooltip-definitions.ts')
    for (const key of ['agentStripTopAgent', 'agentStripTopCostAgent']) {
      const start = source.indexOf(`${key}: {`)
      expect(start).toBeGreaterThan(-1)
      const entry = source.slice(start, source.indexOf('\n  },', start))
      expect(entry).not.toMatch(TASK_WORD)
    }
  })

  it('onboarding sells cost per usage event, not cost per task', () => {
    const source = read(
      'src/features/quick-onboarding/components/steps/ModeSelectionStep.tsx'
    )
    expect(source).not.toMatch(/costs per task/)
    expect(source).toContain('costs per usage event')
  })
})

/**
 * The banned vertical words. LAW_WORD above does not contain "matter", which is the one word the report must not
 * inherit from the goal cards it renders above.
 *
 * The ROI feature files this lists are also covered by the directory scan at
 * the bottom of this file. app/actions/roi-report.ts is not: it lives outside
 * src/features/roi, so this is the only pin on it.
 */
const REPLACED_VOCABULARY =
  /\b(matter|matters|legal|law|firm|firms|case|cases)\b/i

const FINISHED_WORK_COPY_FILES: Array<[string, { jsx: boolean }]> = [
  ['src/features/roi/report-derivation.ts', { jsx: false }],
  ['src/features/roi/components/roi-report.tsx', { jsx: true }],
  ['app/actions/roi-report.ts', { jsx: false }],
  // The Without AI block and the org fields behind it.
  ['src/features/roi/components/without-ai.tsx', { jsx: true }],
  ['app/actions/org-roi-assumptions.ts', { jsx: false }],
]

describe('the ROI report carries none of the banned vertical vocabulary', () => {
  it.each(FINISHED_WORK_COPY_FILES)(
    '%s has no banned word in its display copy',
    (path, options) => {
      const offenders = displayCopy(read(path), options)
        .map((fragment) => fragment.text)
        .filter((text) => REPLACED_VOCABULARY.test(text))
      expect(offenders).toEqual([])
    }
  )
})

const MATTERS_FACE_FILES = {
  sidebar: 'src/components/layout/data/sidebar-data.ts',
  page: 'src/features/law/index.tsx',
  mattersTab: 'src/features/law/components/matters-tab.tsx',
  editDialog: 'src/features/law/components/matter-edit-dialog.tsx',
} as const

describe('the Matters surface reads for every org, not only law firms', () => {
  it('the nav entry for /law carries no law, firm or case wording', () => {
    const source = read(MATTERS_FACE_FILES.sidebar)
    const entry = source.slice(
      source.lastIndexOf('{', source.indexOf("url: '/law'")),
      source.indexOf(
        '}',
        source.indexOf('requiredRoles', source.indexOf("url: '/law'"))
      )
    )
    const title = /title: '([^']*)'/.exec(entry)?.[1]
    const description = /description: '([^']*)'/.exec(entry)?.[1]
    expect(title).toBe('Matters')
    expect(description).toBeDefined()
    expect(description).not.toMatch(LAW_WORD)
    // Work does not bill; it is billed against. Same phrasing as the page,
    // the MCP server instructions and both docs pages.
    expect(description).toContain('the job AI work is billed against')
  })

  it('the page heading and subtitle carry no law, firm or case wording', () => {
    const source = read(MATTERS_FACE_FILES.page)
    const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(source)?.[1]?.trim()
    const subtitle = /<h1[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/
      .exec(source)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim()
    expect(heading).toBe('Matters')
    expect(subtitle).toBeDefined()
    expect(subtitle).not.toMatch(LAW_WORD)
  })

  it('the Matters card never calls matters cases, and its example number is neutral', () => {
    const source = read(MATTERS_FACE_FILES.mattersTab)
    const description = /<CardDescription>([\s\S]*?)<\/CardDescription>/
      .exec(source)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim()
    expect(description).toBeDefined()
    expect(description).not.toMatch(LAW_WORD)
  })

  it('both client fields say Client or team, so a matter can belong to an internal team', () => {
    for (const path of [
      MATTERS_FACE_FILES.mattersTab,
      MATTERS_FACE_FILES.editDialog,
    ]) {
      const source = read(path)
      expect(source).not.toContain('Client name')
      expect(source).toContain('Client or team')
    }
  })

  it('the /law route, the legal role and the tab ids are untouched', () => {
    const source = read(MATTERS_FACE_FILES.sidebar)
    expect(source).toContain("url: '/law'")
    expect(source).toContain("'legal'")
  })
})

/**
 * The ROI surfaces carry none of the vertical's vocabulary. Every
 * file the feature renders is scanned, and the file list is read off disk so a
 * component added next month is covered the day it lands.
 *
 * Identifiers are allowed and deliberately so: matterId is the wire field, and
 * '@/app/actions/matters' is where the action lives. Renaming either
 * is a schema/route change, not a copy fix.
 */
const ROI_FEATURE_DIR = 'src/features/roi'

function roiFeatureFiles(directory: string): string[] {
  return readdirSync(join(DASHBOARD_ROOT, directory), {
    withFileTypes: true,
  }).flatMap((entry) => {
    if (entry.name === '__tests__') return []
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return roiFeatureFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const ROI_FEATURE_FILES: Array<[string, { jsx: boolean }]> = roiFeatureFiles(
  ROI_FEATURE_DIR
)
  .sort()
  .map((path) => [path, { jsx: path.endsWith('.tsx') }])

/** A module specifier, not something a customer reads. */
const isModuleSpecifier = (fragment: string) =>
  /^(@\/|\.{1,2}\/)/.test(fragment) ||
  /^@?[a-z][\w.-]*(\/[\w.@-]+)+$/.test(fragment)

/**
 * displayCopy's JSX-text pass matches `>...<`, which in a .tsx file also spans
 * generics and comparisons and drags real code along with it. No JSX text node
 * a customer reads carries a semicolon or an equals sign.
 *
 * Applied to JSX fragments ONLY: a quoted literal is scanned whatever
 * punctuation it holds, because `'Cost per matter = ...'` is a sentence a
 * customer reads and is exactly where a leak would hide.
 */
const looksLikeCode = (fragment: string) => /[;=]/.test(fragment)

function verticalWordOffenders(
  source: string,
  options: { jsx: boolean }
): string[] {
  return displayCopy(source, options)
    .filter(
      (fragment) => !(fragment.kind === 'jsx' && looksLikeCode(fragment.text))
    )
    .map((fragment) => fragment.text)
    .filter((text) => !isModuleSpecifier(text))
    .filter((text) => VERTICAL_WORD.test(text))
}

describe('the ROI surfaces carry none of the vertical vocabulary', () => {
  it('the scan reads the feature directory, so no file can slip past the list', () => {
    const scanned = ROI_FEATURE_FILES.map(([path]) => path)
    expect(scanned).toEqual(
      expect.arrayContaining([
        `${ROI_FEATURE_DIR}/progress-derivation.ts`,
        `${ROI_FEATURE_DIR}/baseline-derivation.ts`,
        `${ROI_FEATURE_DIR}/index.tsx`,
        `${ROI_FEATURE_DIR}/detail.tsx`,
        `${ROI_FEATURE_DIR}/components/initiative-card.tsx`,
        `${ROI_FEATURE_DIR}/components/initiative-dialog.tsx`,
        `${ROI_FEATURE_DIR}/components/board-ready-export.tsx`,
        `${ROI_FEATURE_DIR}/components/status-maps.ts`,
        `${ROI_FEATURE_DIR}/components/target-trend-chart.tsx`,
      ])
    )
    expect(scanned.filter((path) => path.includes('__tests__'))).toEqual([])
  })

  it.each(ROI_FEATURE_FILES)(
    '%s has no matter, legal, law, firm or case wording in its display copy',
    (path, options) => {
      expect(verticalWordOffenders(read(path), options)).toEqual([])
    }
  )

  it('a quoted sentence is scanned even when it carries code punctuation', () => {
    for (const leak of [
      "const a = 'Matter 2026-0031, this window'",
      "const b = 'No matter (whole organization)'",
      "const c = 'Cost per matter = the job AI work is billed against'",
      "const d = 'Matter cost; all time'",
    ]) {
      expect(verticalWordOffenders(leak, { jsx: true })).not.toEqual([])
    }
  })

  it('a JSX sentence is caught too, and its surrounding code is not', () => {
    expect(
      verticalWordOffenders('<p>Pick a matter to scope this goal</p>', {
        jsx: true,
      })
    ).toEqual(['Pick a matter to scope this goal'])
    expect(
      verticalWordOffenders('{matters.length > 0 && cases;}', { jsx: true })
    ).toEqual([])
  })

  it('module specifiers are never copy', () => {
    expect(
      verticalWordOffenders(
        "import { getMatters } from '@/app/actions/matters'",
        { jsx: false }
      )
    ).toEqual([])
  })

  it('the scope sentences pass the very scan that guards them', () => {
    for (const shipped of [
      SCOPE_SUMMARY_COPY,
      SCOPE_HELPER_COPY,
      matterScopeLabel({
        matterId: 'm1',
        matterNumber: '2026-0031',
        scopedMatterNumber: '2026-0031',
      })!,
      matterScopeLabel({
        matterId: null,
        matterNumber: null,
        scopedMatterNumber: '2026-0031',
      })!,
    ]) {
      expect(VERTICAL_WORD.test(shipped)).toBe(false)
    }
  })

  it('the identifiers this rename deliberately leaves alone are still there', () => {
    const derivation = read('src/features/roi/progress-derivation.ts')
    expect(derivation).toContain('matterId')
    expect(derivation).toContain('scopedMatterNumber')
    expect(derivation).toContain('export function matterScopeLabel')
  })
})

/**
 * The wayfinding rule. "Above" and "below" are true on one screen
 * and false in the print, on a phone, to a screen reader and after a tab moves;
 * "the Agents page" names no page at all, only Build's Agents tab. The positive
 * half: a direction that does not name its surface sends the reader nowhere.
 * The patterns live in ./support/copy-gates so the hover-copy suite runs the
 * same ones over apps/dashboard/lib/tooltip-definitions.ts.
 */

/** Copy here is written as `'half ' + \`half\``, so a fragment-level scan calls
 * "Run the work command " a dead pointer with "in your terminal" one fragment
 * away. Literals joined by nothing but `+` are read back as one sentence. */
function joinedCopy(source: string, options: { jsx: boolean }): string[] {
  const code = stripComments(source)
  const sentences: string[] = []
  let pending = ''
  let pendingEnd = -1

  for (const match of code.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)) {
    const start = match.index ?? 0
    const text = match[0].slice(1, -1)
    if (pendingEnd >= 0 && /^\s*\+\s*$/.test(code.slice(pendingEnd, start))) {
      pending += text
    } else {
      if (pending) sentences.push(pending)
      pending = text
    }
    pendingEnd = start + match[0].length
  }
  if (pending) sentences.push(pending)

  const jsxText = options.jsx
    ? (code.match(/>[^<>{}]+</g) ?? [])
        .map((text) => text.slice(1, -1))
        .filter((text) => !looksLikeCode(text))
    : []

  return [...sentences, ...jsxText]
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .filter((text) => !/^[a-z0-9+_.-]+$/.test(text))
    .filter((text) => !isModuleSpecifier(text))
}

function wayfindingOffenders(
  source: string,
  options: { jsx: boolean }
): string[] {
  return joinedCopy(source, options).filter(
    (text) =>
      LAYOUT_DIRECTION.test(text) ||
      DEAD_PAGE_NAME.test(text) ||
      (MOVES_THE_READER.test(text) && !SURFACE_WORD.test(text))
  )
}

describe('every ROI pointer names the place and the reason', () => {
  it.each(ROI_FEATURE_FILES)(
    '%s points at a findable place in its display copy',
    (path, options) => {
      expect(wayfindingOffenders(read(path), options)).toEqual([])
    }
  )

  it('the gate catches the three shapes it exists to catch', () => {
    expect(
      wayfindingOffenders("const a = 'Check at least one agent above'", {
        jsx: false,
      })
    ).toEqual(['Check at least one agent above'])
    expect(
      wayfindingOffenders("const b = 'Rename them on the Agents page'", {
        jsx: false,
      })
    ).toEqual(['Rename them on the Agents page'])
    expect(
      wayfindingOffenders("const c = 'Run the work command first'", {
        jsx: false,
      })
    ).toEqual(['Run the work command first'])
  })

  // "Above" was only ever the loudest member of a family. A printed report has no
  // top, a phone wraps the row, and "the left" is not a place to a screen reader,
  // so every one of these sends the reader somewhere that does not exist.
  it('the gate catches the rest of the layout-pointer family', () => {
    for (const bad of [
      'the dates at the top of this page',
      'the honesty note at the bottom of the page',
      'the range at the top of the screen',
      'the menu on the left',
      'the kebab on the right',
    ]) {
      expect(wayfindingOffenders(`const x = '${bad}'`, { jsx: false })).toEqual(
        [bad]
      )
    }
  })

  it('the widened gate leaves the surface words it needs alone', () => {
    for (const good of [
      'open ROI in the left menu, then the Finished work tab, to see it',
      'Right now your MarginFront dashboard has no finished work in this window',
    ]) {
      expect(
        wayfindingOffenders(`const y = '${good}'`, { jsx: false })
      ).toEqual([])
    }
  })

  it('a sentence split across two literals is read as one', () => {
    expect(
      wayfindingOffenders(
        "const d = 'Run the work command ' + `in your terminal.`",
        { jsx: false }
      )
    ).toEqual([])
    // And the join does not run away past the operator that is not a join.
    expect(
      joinedCopy("const e = 'Run it' + name + 'above the fold'", { jsx: false })
    ).toEqual(['Run it', 'above the fold'])
  })

  it('a pointer that names its surface passes', () => {
    expect(
      wayfindingOffenders(
        "const f = 'On your MarginFront dashboard, open ROI in the left menu, then the Finished work tab, to see what each one cost.'",
        { jsx: false }
      )
    ).toEqual([])
  })

  it('the only tab words the ROI copy names are the three the product names', () => {
    const source = read('src/features/roi/report-derivation.ts')
    expect(source).toContain('the Summary and Finished work tabs')
    expect(source).toContain('the Finished work tab')

    // Every OTHER tab a sentence names has to be one of the three, with two
    // exceptions: Agents is Build's tab and Subscriptions is Unit Economics's
    // tab, neither of them an ROI tab, so a sentence may name one only when it
    // has already named the menu word that leads there.
    const RULED_TABS = ['Summary', 'Finished work', 'Goals']
    const OTHER_MENUS: Record<string, RegExp> = {
      Agents: /\bBuild\b/,
      Subscriptions: /\bUnit Economics\b/,
    }
    for (const sentence of joinedCopy(source, { jsx: false })) {
      for (const [, named] of sentence.matchAll(
        /\b((?:[A-Z][a-z]+)(?: [a-z]+)?) tabs?\b/g
      )) {
        const menu = OTHER_MENUS[named]
        if (menu) {
          expect(sentence).toMatch(menu)
          continue
        }
        expect(RULED_TABS).toContain(named)
      }
    }
  })
})
