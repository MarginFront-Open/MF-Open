/**
 * SetupMethodModal confirm logic.
 *
 * Mirrors the decision tree inside handleConfirm at:
 *   apps/dashboard/src/components/setup-method-modal.tsx
 *
 * This directory's jest config runs in a NODE environment and only matches
 * *.test.ts — React components and client-only hooks (useRouter,
 * useQueryClient, useToast) are NOT rendered here; those stay on Playwright
 * E2E (see apps/dashboard/jest.config.ts). So this test mirrors the inline
 * call-site decision as a pure function and assert its branches. If handleConfirm's branching
 * changes, update the mirrored function below so these boundary cases stay
 * anchored.
 *
 * The non-obvious invariant: when saving the choice fails, the modal must
 * STAY OPEN (no onComplete) so the user can try again.
 */

type ConfirmOutcome =
  | { kind: 'save-error'; closesModal: false } // updateSetupMethod failed
  | { kind: 'ccc-page'; closesModal: true } // ccc → /internal-ai-spend
  | { kind: 'route'; closesModal: true; method: string } // → getting-started

const decideConfirmOutcome = (
  selectedMethod: string,
  saveOk: boolean
): ConfirmOutcome => {
  if (!saveOk) return { kind: 'save-error', closesModal: false }

  if (selectedMethod === 'ccc') return { kind: 'ccc-page', closesModal: true }

  return { kind: 'route', closesModal: true, method: selectedMethod }
}

describe('SetupMethodModal handleConfirm decision tree (SetupMethodModal.tsx)', () => {
  it('updateSetupMethod fails → save-error, modal stays open (no onComplete)', () => {
    expect(decideConfirmOutcome('mcp', false)).toEqual({
      kind: 'save-error',
      closesModal: false,
    })
  })

  it('mcp → routes to getting-started?method=mcp', () => {
    expect(decideConfirmOutcome('mcp', true)).toEqual({
      kind: 'route',
      closesModal: true,
      method: 'mcp',
    })
  })

  it('sdk → routes to getting-started?method=sdk', () => {
    expect(decideConfirmOutcome('sdk', true)).toEqual({
      kind: 'route',
      closesModal: true,
      method: 'sdk',
    })
  })

  it('api → routes to getting-started?method=api', () => {
    expect(decideConfirmOutcome('api', true)).toEqual({
      kind: 'route',
      closesModal: true,
      method: 'api',
    })
  })

  it('manual → routes to getting-started?method=manual', () => {
    expect(decideConfirmOutcome('manual', true)).toEqual({
      kind: 'route',
      closesModal: true,
      method: 'manual',
    })
  })

  it('ccc → lands on the Internal AI Spend page, not getting-started', () => {
    expect(decideConfirmOutcome('ccc', true)).toEqual({
      kind: 'ccc-page',
      closesModal: true,
    })
  })
})
