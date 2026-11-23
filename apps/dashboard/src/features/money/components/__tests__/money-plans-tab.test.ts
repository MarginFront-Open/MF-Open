import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Money → Plans tab. Source-assertion
 * (dashboard jest is node-only, no RTL — same pattern as
 * money-users-tab.test.ts in this dir). Locks: reuse over re-querying, writes
 * going through the shared pricing-plans.ts actions (no tab-specific server
 * code), and the deactivate dialog
 * being wired in (not a hand-rolled confirm() call).
 */
describe('money-plans-tab.tsx — reuse + wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'money-plans-tab.tsx'), 'utf8')

  it('reuses getFilters() — no direct Prisma/db query in this component', () => {
    expect(src).toMatch(/import \{\s*getFilters,/)
    expect(src).not.toMatch(/PrismaClient/)
    expect(src).not.toMatch(/from '@\/app\/lib\/db'/)
  })

  it('reuses the plans-derivation module, not ad-hoc filtering/counting', () => {
    expect(src).toMatch(/from '\.\.\/plans-derivation'/)
    expect(src).toMatch(/buildPlansTabRows/)
    expect(src).toMatch(/agentsAvailableToLink/)
    expect(src).toMatch(/firstLinkedAgentId/)
  })

  it('wires link/unlink to the pricing-plans.ts actions (no separate server code)', () => {
    expect(src).toMatch(
      /import \{\s*linkPlanToAgent,\s*unlinkPlanFromAgent,\s*updatePricingPlan,?\s*\} from '@\/app\/actions\/pricing-plans'/
    )
    expect(src).toMatch(/linkPlanToAgent\(planId, agentId\)/)
    expect(src).toMatch(/unlinkPlanFromAgent\(planId, agentId\)/)
  })

  it('deactivates/reactivates via the updatePricingPlan action, not a separate mutation', () => {
    expect(src).toMatch(/updatePricingPlan\(planId, \{ isActive \}\)/)
  })

  it('routes the deactivate/reactivate confirmation through PlanActivationDialog, not a bare confirm()', () => {
    expect(src).toMatch(/from '\.\/plan-activation-dialog'/)
    expect(src).toMatch(/<PlanActivationDialog/)
    expect(src).not.toMatch(/window\.confirm/)
  })

  it('links a plan with a linked agent straight to the agent-scoped detail page', () => {
    expect(src).toMatch(
      /href=\{`\/agents\/\$\{detailAgentId\}\/pricing-plans\/\$\{row\.id\}`\}/
    )
  })

  it('routes "New plan" to the agent-scoped create flow, never a second wizard', () => {
    expect(src).toMatch(
      /href=\{`\/agents\/\$\{agents\[0\]\.id\}\/pricing-plans\/new`\}/
    )
    expect(src).toMatch(
      /href=\{`\/agents\/\$\{agent\.id\}\/pricing-plans\/new`\}/
    )
  })
})
