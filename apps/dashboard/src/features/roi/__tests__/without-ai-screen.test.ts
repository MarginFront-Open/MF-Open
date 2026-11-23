/**
 * The finished screen. This suite pins the
 * block's layout: the verdict on top, the three-column table
 * under it, the method chooser with its inputs beside it, and the print
 * button that ends the block.
 *
 * The story paragraph isn't on the screen. It exists, byte for byte,
 * on the paper and in the JSON, and the assertions below pin exactly that:
 * the screen doesn't render it, and the data still carries it.
 *
 * Source-asserted, like every other component suite in this app: dashboard
 * jest is node-only with no React Testing Library, so these are pins on the
 * source, and `npm run build` is the gate that the page still renders.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(__dirname, '..', 'components', 'without-ai.tsx')
const src = readFileSync(COMPONENT_PATH, 'utf8')

describe('the block on screen', () => {
  const at = (needle: string) => {
    const index = src.indexOf(needle)
    expect(index).toBeGreaterThan(-1)
    return index
  }

  it('leads with the verdict, then the stamp that keeps it honest, then the table', () => {
    expect(at('{block.netLine}')).toBeLessThan(at('{block.estimateLabel}'))
    expect(at('{block.estimateLabel}')).toBeLessThan(at('<ComparisonTable'))
  })

  // The headline is the NET: cost saved plus revenue gained, because a
  // comparison that never says what AI made is half an answer.
  it('the verdict a reader meets first is the net, not the cost half of it', () => {
    expect(at('{block.netLine}')).toBeLessThan(at('<ComparisonTable'))
    // The cost verdict sits under the table with the revenue verdict beside
    // it, not in the headline.
    expect(at('{block.netLine}')).toBeLessThan(at('{block.cost.sentence}'))
    expect(at('{block.cost.sentence}')).toBeLessThan(
      at('{block.revenue.sentence}')
    )
  })

  it('the verdict is the largest thing in the block', () => {
    const verdict = src.slice(
      src.lastIndexOf('<p', at('{block.netLine}')),
      at('{block.netLine}')
    )
    expect(verdict).toMatch(/text-\[15px\]/)
    // Nothing else in the block is set larger than the answer.
    expect(src).not.toMatch(/text-\[1[6-9]px\]|text-\[2\d px\]/)
  })

  it('the table is three columns wide: measured, estimated, and the gap', () => {
    expect(src).toMatch(/WITHOUT_AI_COPY\.withAiLabel/)
    expect(src).toMatch(/WITHOUT_AI_COPY\.withoutAiLabel/)
    expect(src).toMatch(/WITHOUT_AI_COPY\.differenceLabel/)
    expect(src).toMatch(/comparisonDifferenceCell\(numbers\)/)
  })

  it('names the method in the estimate column header, where that column came from', () => {
    const header = src.slice(
      at('WITHOUT_AI_COPY.withoutAiLabel'),
      at('WITHOUT_AI_COPY.differenceLabel')
    )
    expect(header).toMatch(/block\.cost\.note/)
  })

  it('the screen omits the story paragraph and keeps everything else', () => {
    expect(src).not.toMatch(/block\.paragraph/)
    expect(src).toMatch(/\{block\.revenueNote\}/)
    expect(src).toMatch(/\{block\.netLine\}/)
    expect(src).toMatch(/\{block\.estimateLabel\}/)
  })

  // The Revenue row always renders, so the table may not gate it.
  it('renders the Revenue row unconditionally, beside the Cost row', () => {
    expect(src).not.toMatch(/\{block\.revenue && block\.numbers\.revenue &&/)
    expect(src).toMatch(/row=\{block\.revenue\}/)
    expect(src).toMatch(/numbers=\{block\.numbers\.revenue\}/)
  })

  it('asks for the revenue figure as a plain question, not an optional extra', () => {
    expect(src).toMatch(/WITHOUT_AI_COPY\.revenuePerMonthLabel/)
    expect(src).toMatch(/WITHOUT_AI_COPY\.revenuePerMonthHelper/)
  })

  it('the print carries the paragraph the screen omits', () => {
    const printSrc = readFileSync(
      join(__dirname, '..', 'components', 'board-ready-export.tsx'),
      'utf8'
    )
    expect(printSrc).toMatch(/report\.withoutAi\.paragraph/)
  })
})

describe('the inputs panel', () => {
  it("puts each method's inputs inside that method's own branch, beside its radio", () => {
    // One flat grid below three radios makes the customer guess which fields
    // belong to the choice they just made.
    const chooser = src.indexOf('WITHOUT_AI_METHODS.map(')
    expect(chooser).toBeGreaterThan(-1)
    const perItem = src.indexOf("method === 'perItem' &&", chooser)
    const peopleTime = src.indexOf("method === 'peopleTime' &&", chooser)
    const periodTotal = src.indexOf("method === 'periodTotal' &&", chooser)
    for (const branch of [perItem, peopleTime, periodTotal]) {
      expect(branch).toBeGreaterThan(chooser)
    }
    const chooserEnd = src.indexOf('</fieldset>', chooser)
    expect(perItem).toBeLessThan(chooserEnd)
    expect(peopleTime).toBeLessThan(chooserEnd)
    expect(periodTotal).toBeLessThan(chooserEnd)
  })

  it('closes on a SUCCESSFUL save, so what you see next is the comparison', () => {
    // Not anywhere in the file: the Close button also calls setOpen(false).
    const save = src.indexOf('await saveOrgRoiAssumptions(')
    expect(save).toBeGreaterThan(-1)
    const successPath = src.slice(save, src.indexOf('} catch {', save))
    expect(successPath).toMatch(/setOpen\(false\)/)
  })

  it('stops asking for a count once the meter has tagged the work', () => {
    expect(src).toMatch(/inputs\.measuredCount !== null/)
    expect(src).toMatch(/WITHOUT_AI_COPY\.countMeasuredNote\(/)
  })

  it('still refuses a half-filled method before it writes', () => {
    const guard = src.indexOf('missingMethodFields(')
    const write = src.indexOf('saveOrgRoiAssumptions(')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(write)
  })
})

describe('Print report ends the block', () => {
  it('IS the header button, not a second door with its own handler', () => {
    expect(src).toMatch(
      /import\s*\{\s*BoardReadyExportButton\s*\}\s*from\s*'\.\/board-ready-export'/
    )
    expect(src).toMatch(
      /<BoardReadyExportButton disabled=\{saving \|\| !goalsRead\}/
    )
    expect(src).not.toMatch(/window\.print\(/)
    expect(src).not.toMatch(/openBoardReadyPrint/)
  })

  // One door, one behaviour, no wait: printing does not save first and wait
  // a render for the count to come back through the URL.
  it('does not save before printing', () => {
    expect(src).not.toMatch(/generateReport/)
    expect(src).not.toMatch(/pendingPrint/)
    expect(src).not.toMatch(/unitsAfterCommit/)
  })

  it('the block takes no data link; the band holds it', () => {
    expect(src).not.toMatch(/dataLink/)
  })
})

describe('every input in the estimate form has an accessible name', () => {
  // A label's control is the first labelable element inside it, and a button
  // is labelable. The tooltip is a real button, so on the revenue field, the
  // one field that has a tooltip, a wrapping label would hand its name to the
  // tooltip and leave the input with no accessible name at all.
  const field = src.slice(src.indexOf('function Field('))

  it('the label names its input by id, so nothing else in the row can take it', () => {
    expect(field).toMatch(/const inputId = useId\(\)/)
    expect(field).toMatch(/<label htmlFor=\{inputId\}>\{label\}<\/label>/)
    expect(field).toMatch(/<input\s+id=\{inputId\}/)
  })

  it('the input is a sibling of its label, never wrapped by it', () => {
    const labelRow = field.slice(
      field.indexOf('<label htmlFor'),
      field.indexOf('</span>')
    )
    expect(labelRow).not.toMatch(/<input/)
  })

  it('there is one Field, so every variant gets the same association', () => {
    expect(src.match(/function Field\(/g)).toHaveLength(1)
    // The tooltip is the variant that could take the label, and it sits in
    // the row.
    expect(field).toMatch(/\{tooltip && <Hover tooltip=\{tooltip\} \/>\}/)
  })
})
