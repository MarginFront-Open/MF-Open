/**
 * The print, and the two things that
 * could silently take page one away from it.
 *
 * The end of the Without AI block uses the same print button the header
 * carries, so there is one door in code and no save-then-print wait. What
 * this file pins is the readiness flag both buttons ride, and the
 * read the page must own itself: Radix unmounts the panel a reader is not on,
 * so anything the print needs that is read inside a panel is missing from a
 * print started on another tab.
 *
 * Source-asserted for the wiring, like every other component suite here
 * (dashboard jest is node-only, no React Testing Library).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { REPORT_COPY } from '../report-derivation'

const read = (...parts: string[]) =>
  readFileSync(join(__dirname, '..', ...parts), 'utf8')

const indexSrc = read('index.tsx')
const reportSrc = read('components', 'roi-report.tsx')
const withoutAiSrc = read('components', 'without-ai.tsx')
const printSrc = read('components', 'board-ready-export.tsx')

const at = (src: string, needle: string) => {
  const index = src.indexOf(needle)
  expect(index).toBeGreaterThan(-1)
  return index
}

describe('one print door, in one place in the code', () => {
  it('only the print module calls window.print, through one named opener', () => {
    expect(printSrc).toMatch(/export function openBoardReadyPrint\(\)/)
    expect(printSrc.match(/window\.print\(/g)).toHaveLength(1)
    for (const src of [indexSrc, reportSrc, withoutAiSrc]) {
      expect(src).not.toMatch(/window\.print\(/)
      expect(src).not.toMatch(/openBoardReadyPrint/)
    }
  })

  it('both buttons ARE that door — the same component, not a second copy of it', () => {
    expect(printSrc.match(/onClick=\{openBoardReadyPrint\}/g)).toHaveLength(1)
    expect(indexSrc).toMatch(
      /<BoardReadyExportButton[\s\S]{0,80}disabled=\{!goalsRead\}/
    )
    expect(withoutAiSrc).toMatch(/<BoardReadyExportButton disabled=\{/)
  })

  // Two identical buttons about 350px apart on the Summary tab. A first-time
  // reader assumes the one inside the card prints the card.
  it('the second door says it is the same door', () => {
    expect(withoutAiSrc).toMatch(/ROI_TOOLTIPS\.printReportAgain/)
    expect(withoutAiSrc).not.toMatch(/ROI_TOOLTIPS\.printReport\b/)
    expect(indexSrc).not.toMatch(/printReportAgain/)
  })

  it('the label and its hover come from the one copy source', () => {
    expect(printSrc).toMatch(/REPORT_COPY\.printReportLabel/)
    expect(printSrc).toMatch(/REPORT_COPY\.printReportHover/)
    expect(REPORT_COPY.printReportLabel).toBe('Print report')
    // The hover has to say what the button does to the reader's screen, and
    // where the PDF they actually want comes from.
    expect(REPORT_COPY.printReportHover).toMatch(/print window/)
    expect(REPORT_COPY.printReportHover).toMatch(/Save as PDF/)
  })
})

describe('both doors to the print carry the same guard', () => {
  it('the page derives readiness ONCE, from the goals read', () => {
    expect(indexSrc).toMatch(/const goalsRead = overviewState === 'ready'/)
    // One derivation, so the two doors cannot drift to different conditions.
    expect(indexSrc.match(/overviewState === 'ready'/g)).toHaveLength(1)
  })

  it('the flag reaches the comparison button, threaded down and never re-derived', () => {
    expect(indexSrc).toMatch(/goalsRead=\{goalsRead\}/)
    expect(reportSrc).toMatch(/goalsRead=\{goalsRead\}/)
    expect(reportSrc).toMatch(/goalsRead: boolean/)
    expect(withoutAiSrc).toMatch(/goalsRead: boolean/)
    expect(withoutAiSrc).toMatch(/disabled=\{saving \|\| !goalsRead\}/)
    // The block holds no read of its own to judge readiness by.
    expect(withoutAiSrc).not.toMatch(/overviewState/)
    expect(withoutAiSrc).not.toMatch(/getRoiOverview/)
  })
})

/**
 * The correctness item: getOrgRoiAssumptions() must not run on mount INSIDE
 * the Without AI block. Radix unmounts the Summary panel when a reader moves
 * to Goals, so a print started from there would find no stored numbers and
 * come out with no comparison on page one.
 */
describe('the print keeps its page one from every tab', () => {
  it('the page reads the stored numbers itself', () => {
    expect(indexSrc).toMatch(
      /import \{ getOrgRoiAssumptions \} from '@\/app\/actions\/org-roi-assumptions'/
    )
    expect(indexSrc).toMatch(/await getOrgRoiAssumptions\(\)/)
    expect(indexSrc).toMatch(/setAssumptions\(/)
  })

  it('the block that renders them holds no read of its own', () => {
    expect(withoutAiSrc).not.toMatch(/getOrgRoiAssumptions/)
    expect(withoutAiSrc).toMatch(/assumptions: RoiAssumptions \| null/)
    // The failure sentence follows the read, so the two cannot disagree about
    // whether the read worked.
    expect(withoutAiSrc).toMatch(/readError: string \| null/)
    expect(indexSrc).toMatch(/WITHOUT_AI_COPY\.readFailed/)
  })

  it('the printable is built from that same read, outside the tabs', () => {
    expect(indexSrc).toMatch(/buildPrintReport\(/)
    const built = indexSrc.slice(
      at(indexSrc, 'buildPrintReport({'),
      at(indexSrc, 'const subtitle')
    )
    expect(built).toMatch(/assumptions,/)
    expect(at(indexSrc, '</Tabs>')).toBeLessThan(
      at(indexSrc, '<BoardReadyExportView')
    )
  })
})

describe('the paper never states a goal count it never read', () => {
  it('the print takes the same flag the doors do', () => {
    expect(printSrc).toMatch(/goalsRead: boolean/)
    expect(indexSrc).toMatch(
      /<BoardReadyExportView\s+initiatives=\{activeViews\}\s+goalsRead=\{goalsRead\}/
    )
  })

  /** The condition guarding the JSX expression that renders `sentence`. */
  const branchAround = (sentence: string) => {
    const at_ = at(printSrc, sentence)
    const tag = printSrc.lastIndexOf('<p', at_)
    return printSrc.slice(printSrc.lastIndexOf('{', tag), at_)
  }

  it('"No goals tracked yet." is reachable ONLY once the goals read landed', () => {
    // An empty array before the read lands is an unread list, and this
    // sentence states it as a count of zero. Both halves of the guard matter.
    const branch = branchAround('No goals tracked yet.')
    expect(branch).toMatch(/goalsRead/)
    expect(branch).toMatch(/initiatives\.length === 0/)
  })

  it('the unread sentence is reachable ONLY while the goals are unread', () => {
    expect(branchAround('REPORT_COPY.goalsUnread')).toMatch(/!goalsRead/)
  })

  it('says why the goals are missing, in copy from the one copy source', () => {
    expect(printSrc).toMatch(/REPORT_COPY\.goalsUnread/)
    expect(REPORT_COPY.goalsUnread).toMatch(/goals/)
    // The sentence has to name the reason, not just omit the section.
    expect(REPORT_COPY.goalsUnread).toMatch(/printed/)
  })

  it('the unread sentence reads like a person wrote it', () => {
    const sentence: string = REPORT_COPY.goalsUnread
    expect(sentence).not.toMatch(/—/)
    expect(sentence).not.toMatch(/\bjust\b/i)
    for (const banned of ['matter', 'legal', 'law firm', 'case']) {
      expect(sentence.toLowerCase()).not.toContain(banned)
    }
  })

  it('the on-screen goal tiles stay off the paper, inside the one no-print wrapper', () => {
    const wrapper = at(indexSrc, "<div className='no-print'>")
    // The error tile, or a printed report shows the on-screen error card.
    expect(at(indexSrc, "overviewState === 'error' ?")).toBeGreaterThan(wrapper)
    // The loading skeletons, or a printed report shows grey placeholder boxes.
    expect(at(indexSrc, "overviewState === 'loading' ?")).toBeGreaterThan(
      wrapper
    )
    expect(at(indexSrc, '<BoardReadyExportView')).toBeGreaterThan(
      at(indexSrc, '</Tabs>')
    )
  })
})
