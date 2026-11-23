/**
 * The scope is a collapsed optional row AFTER the targets, so the
 * metric choices are the first thing in the dialog.
 *
 * dashboard jest is node-only, no React Testing Library — source-assert, the
 * same idiom as the sibling initiative-dialog tests in this directory. The
 * two sentences the row renders are asserted on their real values, because
 * they are built from the shared work-item noun rather than typed inline.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { SCOPE_HELPER_COPY, SCOPE_SUMMARY_COPY } from '../progress-derivation'

const componentSrc = readFileSync(
  join(__dirname, '..', 'components', 'initiative-dialog.tsx'),
  'utf8'
)

/** JSX text children wrap at prettier's printWidth, so collapse whitespace
 * runs before matching prose or tag-plus-text spans. */
const flatSrc = componentSrc.replace(/\s+/g, ' ')

const SUMMARY_TEXT = SCOPE_SUMMARY_COPY
/** What the SOURCE holds where the summary renders — the sentence itself is
 * composed from the shared noun, so position checks anchor on the reference. */
const SUMMARY_TOKEN = '{SCOPE_SUMMARY_COPY}'
const WHOLE_ORG_OPTION = 'Whole organization'

const indexOf = (needle: string) => {
  const at = componentSrc.indexOf(needle)
  expect(at).toBeGreaterThan(-1)
  return at
}

describe('the scope row sits after the targets', () => {
  it('the metric, direction, target value and starting value all come before the scope select', () => {
    const metricLabel = indexOf('<span className={LABEL_CLASS}>Metric</span>')
    const directionLabel = indexOf(
      '<span className={LABEL_CLASS}>Direction</span>'
    )
    const targetValueLabel = indexOf(
      '<span className={LABEL_CLASS}>Target value</span>'
    )
    const startingValueHelper = indexOf('{baselineHelperCopy(row)}')
    const matterSelect = indexOf(WHOLE_ORG_OPTION)

    expect(metricLabel).toBeLessThan(matterSelect)
    expect(directionLabel).toBeLessThan(matterSelect)
    expect(targetValueLabel).toBeLessThan(matterSelect)
    expect(startingValueHelper).toBeLessThan(matterSelect)
  })

  it('the whole targets block closes before the scope row opens', () => {
    const targetsOpen = indexOf('{rows.map((row, index) => (')
    const disclosure = indexOf('<details')
    const targetsClose = componentSrc.indexOf('))}', targetsOpen)
    expect(targetsClose).toBeGreaterThan(targetsOpen)
    expect(disclosure).toBeGreaterThan(targetsClose)
  })

  it('the dates come before the targets', () => {
    const endDateLabel = indexOf(
      '<span className={LABEL_CLASS}>End date (optional)</span>'
    )
    const metricLabel = indexOf('<span className={LABEL_CLASS}>Metric</span>')
    expect(endDateLabel).toBeLessThan(metricLabel)
  })
})

describe('the scope row is a disclosure labelled in plain English', () => {
  it('the summary reads exactly "Narrow to one work item (optional)"', () => {
    expect(SUMMARY_TEXT).toBe('Narrow to one work item (optional)')
    expect(componentSrc).toMatch(
      /<summary[^>]*>\s*\{SCOPE_SUMMARY_COPY\}\s*<\/summary>/
    )
  })

  it('the select lives inside that disclosure', () => {
    const disclosureOpen = indexOf('<details')
    const summaryAt = indexOf(SUMMARY_TOKEN)
    const selectAt = indexOf(WHOLE_ORG_OPTION)
    const disclosureClose = indexOf('</details>')

    expect(summaryAt).toBeGreaterThan(disclosureOpen)
    expect(selectAt).toBeGreaterThan(summaryAt)
    expect(disclosureClose).toBeGreaterThan(selectAt)
  })

  it('it is a native disclosure — keyboard reachable with no new dependency and no toggle handler of our own to get wrong', () => {
    expect(componentSrc.match(/<details/g)).toHaveLength(1)
    expect(componentSrc.match(/<summary/g)).toHaveLength(1)
  })

  it("the summary is styled like the dialog's other secondary control, the starting-figure toggle", () => {
    expect(flatSrc).toMatch(
      /<summary className='[^']*text-\[11px\] font-medium text-mf-tx3 hover:text-mf-tx[^']*'>/
    )
  })
})

describe('the disclosure starts closed, except when the goal already has a scope', () => {
  const effectStart = componentSrc.indexOf('useEffect(() => {')
  const effectEnd = componentSrc.indexOf('}, [open, initiative])')
  const prefillEffect = componentSrc.slice(effectStart, effectEnd)

  it('the prefill effect anchors still exist', () => {
    expect(effectStart).toBeGreaterThan(-1)
    expect(effectEnd).toBeGreaterThan(effectStart)
  })

  it('the open state defaults to closed', () => {
    expect(componentSrc).toMatch(
      /const \[matterOpen, setMatterOpen\] = useState\(false\)/
    )
  })

  it('edit mode opens it only when the goal carries a matterId', () => {
    const editBranch = prefillEffect.slice(
      prefillEffect.indexOf('if (initiative) {'),
      prefillEffect.indexOf('} else {')
    )
    expect(editBranch).toContain('setMatterOpen(initiative.matterId !== null)')
  })

  it('create mode always starts it closed', () => {
    const createBranch = prefillEffect.slice(prefillEffect.indexOf('} else {'))
    expect(createBranch).toContain('setMatterOpen(false)')
  })

  it('the rendered disclosure is driven by that state, and the state follows the user toggling it', () => {
    expect(flatSrc).toMatch(/<details[^>]*open=\{matterOpen\}/)
    expect(flatSrc).toMatch(
      /onToggle=\{\(e\) => \{ const open = e\.currentTarget\.open setMatterOpen\(open\)/
    )
  })
})

describe('the picker keeps its options and wiring', () => {
  it('the whole-organization option is first and is the empty value', () => {
    const selectOpen = indexOf('<select')
    const matterSelectAt = componentSrc.indexOf('<select', indexOf('<details'))
    const defaultOptionAt = componentSrc.indexOf(
      `<option value=''>${WHOLE_ORG_OPTION}</option>`,
      matterSelectAt
    )
    const mappedOptionsAt = componentSrc.indexOf(
      '{matters.map((matter) => (',
      matterSelectAt
    )

    expect(selectOpen).toBeGreaterThan(-1)
    expect(defaultOptionAt).toBeGreaterThan(matterSelectAt)
    expect(mappedOptionsAt).toBeGreaterThan(defaultOptionAt)
  })

  it('an unset scope submits null on both the create and the update payload', () => {
    const submitStart = indexOf('const handleSubmit = async () => {')
    const submitEnd = componentSrc.indexOf('\n\n  return (', submitStart)
    const handleSubmit = componentSrc.slice(submitStart, submitEnd)
    expect(
      handleSubmit.match(/matterId: matterId === '' \? null : matterId/g)
    ).toHaveLength(2)
  })

  it('the select reports through handleMatterChange, so open starting-value previews re-measure against the new scope', () => {
    expect(flatSrc).toMatch(
      /onChange=\{\(e\) => handleMatterChange\(e\.target\.value\)\}/
    )
    expect(componentSrc).toMatch(
      /const scopeChanged = initiative\s*\?\s*\(initiative\.matterId \?\? ''\) !== matterId/
    )
  })

  it('the dialog carries the honest helper sentence about what a scope can and cannot show', () => {
    expect(SCOPE_HELPER_COPY).toContain(
      "Narrowed to one work item, you get that work item's cost, usage events and average cost per usage event."
    )
    expect(componentSrc).toContain('{SCOPE_HELPER_COPY}')
  })
})

describe('an organization with no work items sees no row at all', () => {
  it('the disclosure is rendered only when matters exist', () => {
    expect(componentSrc).toMatch(/\{matters\.length > 0 && \(\s*<details/)
  })

  it('the summary text is inside that guard, so an empty list renders no label either', () => {
    const guardAt = indexOf('{matters.length > 0 && (')
    const summaryAt = indexOf(SUMMARY_TOKEN)
    const guardCloseAt = componentSrc.indexOf('</details>', guardAt)
    expect(summaryAt).toBeGreaterThan(guardAt)
    expect(summaryAt).toBeLessThan(guardCloseAt)
  })
})

describe('the row is reachable and styled like its sibling', () => {
  it('opening the row scrolls it into view, because it is the last element of a scrolling dialog body', () => {
    const detailsIdx = indexOf('<details')
    const detailsClose = componentSrc.indexOf('</details>', detailsIdx)
    const details = componentSrc.slice(detailsIdx, detailsClose)
    expect(details).toMatch(/scrollIntoView\(\{ block: 'nearest' \}\)/)
  })

  it('the scope select uses SELECT_CLASS', () => {
    const optionIdx = indexOf(WHOLE_ORG_OPTION)
    const selectIdx = componentSrc.lastIndexOf('<select', optionIdx)
    const selectClose = componentSrc.indexOf('</select>', selectIdx)
    const select = componentSrc.slice(selectIdx, selectClose)
    expect(select).toMatch(/className=\{SELECT_CLASS\}/)
    expect(select).not.toMatch(/className=\{INPUT_CLASS\}/)
  })

  it('the disclosure uses the dialog rhythm (FIELD_CLASS) and no ad-hoc margin', () => {
    const detailsIdx = indexOf('<details')
    const detailsClose = componentSrc.indexOf('</details>', detailsIdx)
    const details = componentSrc.slice(detailsIdx, detailsClose)
    expect(details).toMatch(/<details[^>]*className=\{FIELD_CLASS\}/)
    expect(details).not.toMatch(/mt-2/)
  })
})
