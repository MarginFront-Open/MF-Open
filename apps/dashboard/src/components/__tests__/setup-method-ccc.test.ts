import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The 'ccc' setup path. Source-assertion (node-only jest, no RTL). The
 * modal's confirm handler routes methods to
 * /developer-zone/getting-started?method=X, EXCEPT 'ccc', which lands on the
 * Internal AI Spend page (the page is the hub; its Internal Setup tab points
 * onward to the walkthrough). So all the pieces must agree: the SetupMethod union, the modal card, the ccc special-case,
 * the page's onward link, and the getting-started tab that link lands on.
 */
const DASHBOARD = join(__dirname, '..', '..', '..')
const actionSrc = readFileSync(
  join(DASHBOARD, 'app', 'actions', 'setup-method.ts'),
  'utf8'
)
const modalSrc = readFileSync(
  join(__dirname, '..', 'setup-method-modal.tsx'),
  'utf8'
)
const gettingStartedSrc = readFileSync(
  join(
    DASHBOARD,
    'src',
    'features',
    'developer-zone',
    'getting-started',
    'index.tsx'
  ),
  'utf8'
)
const internalAiSpendSrc = readFileSync(
  join(DASHBOARD, 'src', 'features', 'internal-ai-spend', 'index.tsx'),
  'utf8'
)

describe("SetupMethod 'ccc' path", () => {
  it("the SetupMethod union includes 'ccc'", () => {
    expect(actionSrc).toMatch(/export type SetupMethod =[^\n]*'ccc'/)
  })

  it("the modal offers the 'Track Our Own AI Spend' card for method 'ccc'", () => {
    expect(modalSrc).toContain("method: 'ccc'")
    expect(modalSrc).toContain("title: 'Track Our Own AI Spend'")
  })

  it("the modal special-cases 'ccc' to land on /internal-ai-spend, before the getting-started fallthrough", () => {
    expect(modalSrc).toContain("selectedMethod === 'ccc'")
    expect(modalSrc).toContain("router.push('/internal-ai-spend')")
    const cccBranchAt = modalSrc.indexOf("selectedMethod === 'ccc'")
    const fallthroughAt = modalSrc.indexOf(
      '/developer-zone/getting-started?method=${selectedMethod}'
    )
    expect(cccBranchAt).toBeGreaterThan(-1)
    expect(fallthroughAt).toBeGreaterThan(cccBranchAt)
  })

  it('the Internal AI Spend page points onward to the guided walkthrough', () => {
    expect(internalAiSpendSrc).toContain(
      "href='/developer-zone/getting-started?method=ccc'"
    )
  })

  it("the getting-started page has a 'ccc' tab for the ?method=ccc deep-link to land on", () => {
    expect(gettingStartedSrc).toMatch(/id: 'ccc'/)
  })
})
