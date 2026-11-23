import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * A rejected read must reach the tab's error state.
 *
 * `.then` does not run on a rejection, so without a catch a failed read would
 * leave state on 'loading' and show a skeleton with no message. Dashboard jest is node-only
 * (no RTL), so this pins the wiring against source the same way
 * spend-controls-subtabs.test.ts does.
 */
const tabSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
const actionSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    'actions',
    'spend-controls.ts'
  ),
  'utf8'
)

describe('internal-ai-spend/index.tsx — a failed load is visible', () => {
  it('attaches a .catch to the load, not just a .then', () => {
    expect(tabSrc).toMatch(/getSpendControlsData\(\)\s*\n?\s*\.then\(/)
    // Takes the rejection as an argument: it reports it to Sentry on the
    // way past, so a swallowed outage still leaves a trace.
    expect(tabSrc).toMatch(/\.catch\(\(err\) => \{/)
  })

  it("moves to 'error' when the action rejects, so the error copy renders", () => {
    // Bounded to the catch body. Slicing to end-of-file would stay green on an
    // empty .catch(() => {}) as soon as anything later in the file sets 'error'.
    const catchBlock = tabSrc.slice(
      tabSrc.indexOf('.catch(('),
      tabSrc.indexOf('.catch((') + 160
    )
    expect(catchBlock).toMatch(/setState\('error'\)/)
  })

  it('still honors the cancelled guard inside the catch', () => {
    const catchBlock = tabSrc.slice(
      tabSrc.indexOf('.catch(('),
      tabSrc.indexOf('.catch((') + 160
    )
    expect(catchBlock).toContain('if (cancelled) return')
  })

  it('keeps the error copy the user actually sees', () => {
    expect(tabSrc).toContain(
      'errorMessage="We couldn\'t load your spend controls. Refresh to try again."'
    )
  })
})

describe('spend-controls.ts — the read converts a throw into the failure arm', () => {
  it('wraps the read so a throw becomes { success: false }', () => {
    // The read sits behind the shared deadline, so the call the try
    // wraps is withDeadline(loadSpendControlsData), not the bare load.
    expect(actionSrc).toMatch(
      /export async function getSpendControlsData\(\)[\s\S]{0,120}try \{[\s\S]{0,80}return await withDeadline\(loadSpendControlsData\)/
    )
    expect(actionSrc).toMatch(/success: false,\s*\n\s*error: "We couldn't load/)
  })

  it('re-reports to Sentry before converting, so a swallowed outage stays visible', () => {
    expect(actionSrc).toContain(
      "import { captureException } from '@sentry/nextjs'"
    )
    const catchBlock = actionSrc.slice(
      actionSrc.indexOf('} catch (err) {'),
      actionSrc.indexOf('} catch (err) {') + 240
    )
    expect(catchBlock).toContain('captureException(err)')
  })
})
