/**
 * Per-bucket revenue aggregation (pure, no DB).
 *
 * The DB-gated PARITY proof (equal to getFullCommandCenterBreakdown for the
 * same window+dimension) lives in
 * app/actions/__tests__/revenue-by-dimension-parity.integration.test.ts.
 *
 * Earned (agent/signal) is NOT aggregated here:
 * it comes from canon getAgentEarned bucketed by dimension (see
 * earnedBucketsFromAgentEarned + the parity suite's graduated/floor/cancelled
 * cases), because per-event pricing under-/over-counts tiers, floors, and
 * cancelled subs. This file pins the BILLED aggregation, proves the HONEST-NULL
 * contract (non-definable dimensions return null, no fabrication path), and
 * source-locks that the earned path derives from canon, not per-event.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { PrismaClient } from '@prisma/client'
import {
  aggregateBilled,
  getRevenueByDimension,
  type BilledInvoiceInput,
} from '../revenue-by-dimension'

describe('aggregateBilled — Billed grouped by customer / plan (PARITY logic)', () => {
  const invoices: BilledInvoiceInput[] = [
    { customerId: 'cust1', planId: 'planA', totalAmount: 100 },
    { customerId: 'cust1', planId: 'planB', totalAmount: 50 },
    { customerId: 'cust2', planId: 'planA', totalAmount: 25 },
    { customerId: 'cust2', planId: null, totalAmount: 10 }, // no plan → dropped from plan grouping
  ]

  it('by customer: SUM(totalAmount) per customerId', () => {
    const { byKey, total } = aggregateBilled(
      invoices,
      (invoice) => invoice.customerId
    )
    expect(byKey.get('cust1')).toBeCloseTo(150, 6)
    expect(byKey.get('cust2')).toBeCloseTo(35, 6)
    expect(total).toBeCloseTo(185, 6)
  })

  it('by plan: SUM(totalAmount) per planId; plan-less invoices are not attributable', () => {
    const { byKey, total } = aggregateBilled(
      invoices,
      (invoice) => invoice.planId
    )
    expect(byKey.get('planA')).toBeCloseTo(125, 6)
    expect(byKey.get('planB')).toBeCloseTo(50, 6)
    // The $10 no-plan invoice is excluded — matches full-command-center's
    // revenueByPlanId, which only keys plan-bearing invoices.
    expect(total).toBeCloseTo(175, 6)
  })
})

describe('getRevenueByDimension — non-definable dimensions return null (HONEST-NULL, no DB)', () => {
  // A dimension with no revenue basis returns BEFORE any DB read, so a null
  // prisma proves no query is attempted for model/environment/day/costCategory.
  const noPrisma = undefined as unknown as PrismaClient
  const window = { start: new Date('2026-04-01'), end: new Date('2026-04-30') }

  it.each(['model', 'environment', 'day', 'costCategory'] as const)(
    '%s → null (never a cost-share-allocated number)',
    async (dimension) => {
      await expect(
        getRevenueByDimension(noPrisma, 'org', window, dimension)
      ).resolves.toBeNull()
    }
  )
})

describe('revenue-by-dimension.ts source — no fabrication path (HONEST-NULL)', () => {
  const SRC = readFileSync(
    join(__dirname, '..', 'revenue-by-dimension.ts'),
    'utf8'
  )

  // Code-token asserts (prose-proof): these are the tell-tale cost-share
  // allocation identifiers from full-command-center's Model/Service tabs. Their
  // ABSENCE proves this module never fabricates per-bucket revenue.
  it('never cost-share-allocates revenue (no per-child cost split)', () => {
    expect(SRC).not.toMatch(/totalChildCost/)
    expect(SRC).not.toMatch(/children\.length/)
    expect(SRC).not.toMatch(/earnedByService/)
  })

  it('derives Earned from canon getAgentEarned, never per-event pricing', () => {
    // Canon bucket path: call getAgentEarned + bucket it. NOT per-event —
    // earnedForEvent / calcRouted price one event alone and miss tier-crossing,
    // floors, and cancelled subs.
    expect(SRC).toMatch(/getAgentEarned\(/)
    expect(SRC).toMatch(/earnedBucketsFromAgentEarned\(/)
    expect(SRC).not.toMatch(/earnedForEvent\s*\(/)
    expect(SRC).not.toMatch(/calcRouted\s*\(/)
  })

  it('does not import from full-command-center (the XLSX path stays untouched)', () => {
    expect(SRC).not.toMatch(/from\s+['"][^'"]*full-command-center/)
  })
})
