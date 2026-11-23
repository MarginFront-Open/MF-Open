import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * One object, ONE noun. The page heading, the card menu, the delete dialog
 * and the print header all say "goal", so a customer never reads two words
 * for one thing in consecutive sentences.
 *
 * "goal" is the customer word. "initiative" is only the internal
 * type, action, component and route name, which is why this sweeps rendered
 * copy rather than the whole file.
 *
 * Source-asserted: dashboard jest is node-only, no RTL.
 */

const FEATURE_DIR = join(__dirname, '..')

function read(...parts: string[]) {
  return readFileSync(join(FEATURE_DIR, ...parts), 'utf8')
}

const indexSrc = read('index.tsx')
const cardSrc = read('components', 'initiative-card.tsx')
const dialogSrc = read('components', 'initiative-dialog.tsx')
const detailSrc = read('detail.tsx')
const printSrc = read('components', 'board-ready-export.tsx')

const SURFACES: Array<[string, string]> = [
  ['index.tsx', indexSrc],
  ['components/initiative-card.tsx', cardSrc],
  ['components/initiative-dialog.tsx', dialogSrc],
  ['detail.tsx', detailSrc],
  ['components/board-ready-export.tsx', printSrc],
]

/** JSX text children, the idiom board-ready-export.test.ts already uses. */
function jsxProse(src: string): string[] {
  const withoutComments = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
  return (withoutComments.match(/>[^<>{}]+</g) ?? [])
    .map((fragment) => fragment.slice(1, -1).replace(/\s+/g, ' ').trim())
    .filter((fragment) => /[A-Za-z]{3}/.test(fragment))
}

/** Toast titles and descriptions, which are copy even though they are not JSX. */
function toastCopy(src: string): string[] {
  return (src.match(/(?:title|description):\s*(['"])(?:\\.|(?!\1).)*\1/g) ?? [])
    .map((match) => match.replace(/^(?:title|description):\s*/, ''))
    .map((literal) => literal.slice(1, -1))
}

describe('every rendered string calls it a goal', () => {
  it.each(SURFACES)('%s renders no visible "initiative"', (_name, src) => {
    for (const line of jsxProse(src)) {
      expect(line).not.toMatch(/\binitiatives?\b/i)
    }
  })

  it.each(SURFACES)(
    '%s raises no toast that says "initiative"',
    (_name, src) => {
      for (const line of toastCopy(src)) {
        expect(line).not.toMatch(/\binitiatives?\b/i)
      }
    }
  )
})

describe('the strings a customer actually clicks', () => {
  it('the card menu and its confirmations', () => {
    expect(cardSrc).toContain('Edit goal')
    expect(cardSrc).toContain('Delete goal')
    expect(cardSrc).toContain(
      '<AlertDialogTitle>Delete goal?</AlertDialogTitle>'
    )
    expect(cardSrc).toContain("'Unarchive goal' : 'Archive goal'")
  })

  it('the create and edit dialog, its buttons and its toasts', () => {
    expect(dialogSrc).toContain("initiative ? 'Edit goal' : 'New goal'")
    expect(dialogSrc).toContain("title: 'Goal saved'")
    expect(dialogSrc).toContain("title: 'Goal created'")
    expect(dialogSrc).toContain("'Save goal'")
    expect(dialogSrc).toContain("'Create goal'")
  })

  it('the list page, its add card and its error', () => {
    expect(indexSrc).toContain("'1 goal tracked'")
    expect(indexSrc).toContain('goals tracked')
    expect(indexSrc).toContain('＋ New goal')
    expect(indexSrc).toContain('Track your first goal')
    expect(indexSrc).toContain("Couldn't load your goals.")
  })

  it('the detail page and the print header', () => {
    expect(detailSrc).toContain('About this goal')
    // Page one leads with the report and the goals come last, so the
    // page-one title names the report. The goals keep their own heading.
    expect(printSrc).toContain('ROI report')
    expect(printSrc).toContain('REPORT_COPY.goalsHeading')
    expect(printSrc).toContain('No goals tracked yet.')
  })

  it('the page has no mid-page definition sentence — one word needs no glossary', () => {
    expect(indexSrc).not.toContain(
      'An initiative is a money goal with a window'
    )
    expect(indexSrc).not.toMatch(/is a money goal with a window/)
  })
})

describe('"initiative" survives as the internal name, which is the point', () => {
  it('the component, the type and the action keep their names', () => {
    expect(indexSrc).toMatch(/<InitiativeCard/)
    expect(indexSrc).toMatch(/\bRoiInitiativeView\b/)
    expect(readdirSync(join(FEATURE_DIR, 'components'))).toContain(
      'initiative-card.tsx'
    )
  })
})
