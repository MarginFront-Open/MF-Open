/**
 * Integration test: `client.analytics.agentEarned()`
 *
 * Canon R1 pure. Activity-only revenue (events × pricing-strategy rate).
 * Skipped unless MF_TEST_SECRET_KEY is set.
 *
 * What it proves:
 *   1. AgentEarned top-level shape (revenue, eventCount, breakdowns).
 *   2. bySubscription + byStrategy rows match canonical shape.
 *   3. Agent-Earned revenue ≤ full Revenue for the same window. Canonical
 *      relationship: Earned is a subset of total Revenue (excludes
 *      recurring + seat + onetime), so it must be less-than-or-equal.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK analytics.agentEarned() (live API)", () => {
  let client: MarginFrontClient;
  const endDate = new Date().toISOString();
  const startDate = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  beforeAll(() => {
    client = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      fireAndForget: false,
      timeout: 15000,
      retries: 0,
    });
  });

  it("returns canonical AgentEarned shape", async () => {
    const earned = await client.analytics.agentEarned({ startDate, endDate });
    expect(typeof earned.revenue).toBe("number");
    expect(Number.isFinite(earned.revenue)).toBe(true);
    expect(earned.eventCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(earned.eventCount)).toBe(true);
    expect(Array.isArray(earned.bySubscription)).toBe(true);
    expect(Array.isArray(earned.byStrategy)).toBe(true);
  });

  it("bySubscription rows have canonical per-sub shape", async () => {
    const earned = await client.analytics.agentEarned({ startDate, endDate });
    for (const row of earned.bySubscription) {
      expect(typeof row.subscriptionId).toBe("string");
      expect(typeof row.customerId).toBe("string");
      expect(typeof row.agentId).toBe("string");
      expect(typeof row.planId).toBe("string");
      expect(typeof row.revenue).toBe("number");
      expect(row.eventCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("byStrategy rows have canonical per-strategy shape", async () => {
    const earned = await client.analytics.agentEarned({ startDate, endDate });
    for (const row of earned.byStrategy) {
      expect(typeof row.strategyId).toBe("string");
      // pricingModel + signalId are nullable. null for some strategies.
      if (row.pricingModel !== null) {
        expect(["flat", "graduated", "volume", "credit_pool"]).toContain(
          row.pricingModel,
        );
      }
      expect(typeof row.revenue).toBe("number");
      expect(typeof row.quantity).toBe("number");
    }
  });

  it("agentEarned.revenue <= analytics.revenue() total (canonical subset)", async () => {
    // Agent-Earned excludes recurring/seat/onetime. Revenue includes all
    // four chargeType contributions. So earned ≤ revenue by construction.
    // Same window, same scope → canon invariant.
    const [earned, revenue] = await Promise.all([
      client.analytics.agentEarned({ startDate, endDate }),
      client.analytics.revenue({ startDate, endDate }),
    ]);
    // Tolerance: same instant both calls, so only float drift matters.
    expect(earned.revenue).toBeLessThanOrEqual(revenue.revenue + 0.01);
  });

  it("agentEarned.revenue ≈ analytics.revenue().usageRevenue (canonical equivalence)", async () => {
    // Stronger invariant: agent-earned IS the usage-only slice of revenue
    // when no special window/filter is at play. Not strictly equal because
    // agent-earned counts by strategy while usageRevenue slices by sub,
    // but the totals should be within floating-point tolerance.
    const [earned, revenue] = await Promise.all([
      client.analytics.agentEarned({ startDate, endDate }),
      client.analytics.revenue({ startDate, endDate }),
    ]);
    expect(Math.abs(earned.revenue - revenue.usageRevenue)).toBeLessThan(0.01);
  });
});
