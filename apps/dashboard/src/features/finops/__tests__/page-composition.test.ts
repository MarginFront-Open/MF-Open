/**
 * FinOps page-composition facts, source-
 * asserted (dashboard jest is node-only, no RTL; the page imports @dnd-kit
 * through TileGrid so it can't be imported here). Each assertion pins a
 * contract a later refactor could silently break:
 *
 *   - single-data-path: the metrics resolver is never referenced in this
 *     feature — the page's ONE DimensionedSection is the only resolver call.
 *   - no default chart: showChart={false} on that section; the add-panel
 *     chart renders from the bridged series, not a second fetch.
 *   - journal single-source: lines come from buildJournalLines, totals from
 *     journal.totalAmount verbatim — no local debit/credit re-derivation.
 *   - close controls keep their copy and the byte-identical export
 *     URLs.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const FEATURE_DIR = join(__dirname, '..')

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const featureFiles = walkTsFiles(FEATURE_DIR)
const indexSrc = readFileSync(join(FEATURE_DIR, 'index.tsx'), 'utf8')
const journalPreviewSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'journal-preview.tsx'),
  'utf8'
)
const closeControlsSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'close-controls.tsx'),
  'utf8'
)
const glMappingSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'gl-mapping-table.tsx'),
  'utf8'
)

describe('single-data-path invariant', () => {
  it.each(featureFiles.map((f) => f.slice(FEATURE_DIR.length + 1)))(
    '%s never references the metrics resolver',
    (relPath) => {
      const src = readFileSync(join(FEATURE_DIR, relPath), 'utf8')
      expect(src).not.toMatch(/resolveMetrics/)
    }
  )
})

describe('index.tsx — the DimensionedSection invocation', () => {
  it('passes showChart={false} — FinOps has NO default time-series chart', () => {
    expect(indexSrc).toMatch(/showChart=\{false\}/)
  })

  it('passes showDonut={false} — FinOps is table-only below the KPI row', () => {
    expect(indexSrc).toMatch(/showDonut=\{false\}/)
  })

  it('defaults the dimension to costCategory', () => {
    expect(indexSrc).toMatch(/initialDimension='costCategory'/)
    expect(indexSrc).not.toMatch(/showDimensionPicker=\{false\}/)
  })

  it('passes no title/chartTitle prop — the section headings ("Cost by …") follow the picker', () => {
    const start = indexSrc.indexOf('<DimensionedSection')
    expect(start).toBeGreaterThan(-1)
    // The invocation's prop list runs from the opening tag to its renderKpiRow
    // slot (the first nested JSX) — a title= there would override the
    // dimension-driven headings.
    const end = indexSrc.indexOf('renderKpiRow', start)
    expect(end).toBeGreaterThan(start)
    const props = indexSrc.slice(start, end)
    expect(props).not.toMatch(/\btitle=/)
    expect(props).not.toMatch(/\bchartTitle=/)
  })
})

describe('index.tsx — close-derivation is the only copy source', () => {
  it('renders the alert items from the derivation module, never an inline string', () => {
    expect(indexSrc).toMatch(/items=\{derived\?\.alerts/)
    expect(indexSrc).not.toMatch(/wrong account type/)
  })

  it('the GL-mapping header count is the SAME derived value the KPI tile shows', () => {
    expect(indexSrc).toMatch(/unmappedCount=\{derived\?\.tiles\.unmappedCount/)
  })

  it('ships the locked-month banner with the posted-snapshot copy', () => {
    expect(indexSrc).toMatch(/is closed/)
    expect(indexSrc).toMatch(/posted snapshot/)
  })
})

// Closing is explained on the page itself, not only inside the confirm
// dialog, gated to the open-month branch only.
describe('index.tsx — open-month "what closing does" explainer', () => {
  // JSX text reflows across lines under prettier, so pull the paragraph's
  // raw source and collapse whitespace before asserting on its wording —
  // asserting against literal line breaks would be a landmine every reformat.
  function explainerParagraph(): string {
    const start = indexSrc.indexOf('What closing does')
    expect(start).toBeGreaterThan(-1)
    const blockEnd = indexSrc.indexOf('</div>', start)
    return indexSrc.slice(start, blockEnd).replace(/\s+/g, ' ').trim()
  }

  it('is gated to the NOT-locked branch, a sibling of the locked banner', () => {
    expect(indexSrc).toMatch(/\{facts && !facts\.lock\.locked && \(/)
  })

  it('names the four concrete effects of closing', () => {
    const paragraph = explainerParagraph()
    expect(paragraph).toContain(
      'Closing a month freezes its numbers so your reports stop moving.'
    )
    expect(paragraph).toContain(
      'won’t change that month’s journal, CSVs, or margin.'
    )
    expect(paragraph).toContain(
      'You can reopen a closed month later, and every reopen is recorded.'
    )
    expect(paragraph).toContain('A month can be closed only after it ends.')
  })

  it('has no em dash in its copy', () => {
    expect(explainerParagraph()).not.toMatch(/—/)
  })
})

// FinOps's alert list checks ONLY GL account-type mismatches
// (close-derivation.ts alerts), so the needs-attention tile's empty state
// names that one check instead of implying a broader sweep.
describe('index.tsx — needs-attention empty state names the ONE check FinOps runs', () => {
  it('names the GL account-type check instead of the generic shared copy', () => {
    expect(indexSrc).toMatch(
      /emptyMessage='All signals are booked to the right account type\. Nothing to fix before you close\.'/
    )
    expect(indexSrc).not.toMatch(/emptyMessage='Nothing needs attention'/)
  })
})

describe('journal-preview.tsx — single-source journal', () => {
  it('imports buildJournalLines from the canonical journal-utils home', () => {
    expect(journalPreviewSrc).toMatch(
      /import\s*\{[^}]*\bbuildJournalLines\b[^}]*\}\s*from\s*['"]@\/features\/cost-management\/journal-utils['"]/
    )
  })

  it('re-derives nothing: no .toFixed, no .reduce over the lines', () => {
    expect(journalPreviewSrc).not.toMatch(/\.toFixed\(/)
    expect(journalPreviewSrc).not.toMatch(/\.reduce\(/)
  })

  it('renders journal.totalAmount verbatim in the totals footer', () => {
    expect(journalPreviewSrc).toMatch(/formatCost\(journal\.totalAmount\)/)
  })

  it('keeps the export URLs byte-identical to month-end-close', () => {
    expect(journalPreviewSrc).toMatch(
      /\/api\/export\/journal\?start=\$\{startDate\}&end=\$\{endDate\}&format=\$\{fmt\}/
    )
  })

  it('links back to the full close view', () => {
    expect(journalPreviewSrc).toMatch(/href='\/month-end-close'/)
  })
})

describe('close-controls.tsx: close/reopen handlers', () => {
  it('keeps the dialog and button copy anchors verbatim', () => {
    expect(closeControlsSrc).toMatch(/Close the books/)
    expect(closeControlsSrc).toMatch(/Reopen period/)
  })

  // The disabled-tooltip copy names WHICH month isn't over yet, via monthLabel.
  it('the disabled-close tooltip names the month instead of generic copy', () => {
    expect(closeControlsSrc).toMatch(
      /\$\{monthLabel\} isn.t over yet\. You can close it once it ends\./
    )
    expect(closeControlsSrc).not.toMatch(
      /You can close this period after the month ends\./
    )
  })
})

// No em dash in rendered UI copy. Code comments may keep theirs, so strip
// them before asserting: the test only inspects what actually renders.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('index.tsx + close-controls.tsx — no em dash in rendered copy', () => {
  it('index.tsx has none outside comments', () => {
    expect(stripComments(indexSrc)).not.toMatch(/—/)
  })

  it('close-controls.tsx has none outside comments', () => {
    expect(stripComments(closeControlsSrc)).not.toMatch(/—/)
  })
})

describe('gl-mapping-table.tsx — honest 3-state mapping + month-scoped header', () => {
  it('derives the category Default state instead of collapsing it into Mapped', () => {
    expect(glMappingSrc).toMatch(/'default'/)
    expect(glMappingSrc).toMatch(/UNCLASSIFIED/)
  })

  it('words the header count as a month-scoped journal fact, not a pill count', () => {
    expect(glMappingSrc).toMatch(/unmapped this month/)
    expect(glMappingSrc).not.toMatch(/signals unmapped/)
  })

  it('carries the month bounds on the classification deep-link', () => {
    expect(glMappingSrc).toMatch(
      /\/finops\?tab=cost-management&startDate=\$\{startDate\}&endDate=\$\{endDate\}/
    )
  })

  it('links to the Settings tab — edits stay where they live', () => {
    expect(glMappingSrc).toMatch(/href='\/finops\?tab=settings'/)
  })
})

describe('close/reopen stays prominent in the page header', () => {
  it('mounts CloseControls as headerExtras, not buried in the page body', () => {
    const headerStart = indexSrc.indexOf('headerExtras={')
    const pageShellCloseTag = indexSrc.indexOf('onSaveLayout=')
    expect(headerStart).toBeGreaterThan(-1)
    expect(pageShellCloseTag).toBeGreaterThan(headerStart)
    const headerExtrasBlock = indexSrc.slice(headerStart, pageShellCloseTag)
    expect(headerExtrasBlock).toMatch(/<CloseControls/)
  })
})

describe('GL rule creation / mapping / categorization reachable from FinOps', () => {
  it('index.tsx puts a GL-settings link in the page header (headerExtras), same prominence tier as close/reopen', () => {
    const headerStart = indexSrc.indexOf('headerExtras={')
    const pageShellCloseTag = indexSrc.indexOf('onSaveLayout=')
    const headerExtrasBlock = indexSrc.slice(headerStart, pageShellCloseTag)
    expect(headerExtrasBlock).toMatch(/href='\/finops\?tab=settings'/)
  })

  it("index.tsx's header link reuses the existing finops-settings rule/GL-code editors — no new mutation logic", () => {
    expect(indexSrc).not.toMatch(
      /upsertGlCode|upsertClassificationRule|assignSignalToGlCode|classifySignal/
    )
  })

  it('gl-mapping-table.tsx styles both deep-links as buttons (bordered + icon), not bare text easy to miss', () => {
    expect(glMappingSrc).toMatch(/ACTION_LINK_CLASS/)
    expect(glMappingSrc).toMatch(/<Tags className/)
    expect(glMappingSrc).toMatch(/<Settings2 className/)
  })

  it('gl-mapping-table.tsx still reuses the canon actions read-only (getSignalsForClassification) — never re-implements classify/GL-assign here', () => {
    expect(glMappingSrc).not.toMatch(
      /classifySignal|assignSignalToGlCode|upsertGlCode|upsertClassificationRule/
    )
  })
})
