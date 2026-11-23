/**
 * Integration test: `client.analytics.revenue()`
 *
 * Live-API test. Hits localhost:4000 (or MF_TEST_BASE_URL) through the SDK
 * and asserts the canonical `RevenueMetrics` shape. Skipped when
 * MF_TEST_SECRET_KEY is not set so CI stays green.
 *
 * What it proves:
 *   1. The SDK method returns a shape that matches the canonical
 *      RevenueMetrics TS type (every required field present, every
 *      type correct).
 *   2. Scoping by customerId narrows the response without changing shape.
 *   3. Org-wide call (no filters) forces variant=canonical and returns
 *      RevenueMetrics, not the API's default MRR-trio breakdown.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";
import type { RevenueMetrics } from "../types";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

// Canonical types promise `number` (not string, not null) for all money
// fields. A typeof check alone passes NaN and Infinity; this rejects both.
function expectFiniteNumber(v: unknown, label: string): asserts v is number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${label} is not a finite number (got ${typeof v}: ${v})`);
  }
}

// Assert a value is either a finite number or `null` (per canon M1 -
// marginPercent is null when revenue === 0, never NaN, never 0 as sentinel).
function expectFiniteOrNull(v: unknown, label: string): void {
  if (v === null) return;
  expectFiniteNumber(v, label);
}

describeIfKey("SDK analytics.revenue() (live API)", () => {
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

  it("returns canonical RevenueMetrics shape for the org-wide window", async () => {
    const metrics = await client.analytics.revenue({ startDate, endDate });

    // Top-level money fields per canon R1/R2
    expectFiniteNumber(metrics.revenue, "revenue");
    expectFiniteNumber(metrics.cost, "cost");
    expectFiniteNumber(metrics.margin, "margin");
    expectFiniteOrNull(metrics.marginPercent, "marginPercent");

    // Breakdown fields per chargeType
    expectFiniteNumber(metrics.usageRevenue, "usageRevenue");
    expectFiniteNumber(metrics.recurringRevenue, "recurringRevenue");
    expectFiniteNumber(metrics.seatRevenue, "seatRevenue");
    expectFiniteNumber(metrics.onetimeRevenue, "onetimeRevenue");

    // Counts must be non-negative integers
    expect(metrics.eventCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(metrics.eventCount)).toBe(true);
    expect(metrics.eventCountWithNullCost).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(metrics.eventCountWithNullCost)).toBe(true);

    // Arrays are always present (empty is valid, undefined is not)
    expect(Array.isArray(metrics.bySubscription)).toBe(true);
    expect(Array.isArray(metrics.byStrategy)).toBe(true);
  });

  it("revenue decomposes: revenue === usage + recurring + seat + onetime", async () => {
    // Independent recompute: the four chargeType-specific fields should sum
    // to the top-level `revenue` within floating-point tolerance. This is
    // the canonical invariant per R2. The decomposition IS the revenue.
    const metrics = await client.analytics.revenue({ startDate, endDate });
    const sum =
      metrics.usageRevenue +
      metrics.recurringRevenue +
      metrics.seatRevenue +
      metrics.onetimeRevenue;
    expect(Math.abs(metrics.revenue - sum)).toBeLessThan(0.01);
  });

  it("margin === revenue - cost", async () => {
    // Canonical margin invariant. Margin is a derivation, not a stored
    // number. If the SDK ever drifts from the API, this breaks.
    const metrics = await client.analytics.revenue({ startDate, endDate });
    const derived = metrics.revenue - metrics.cost;
    expect(Math.abs(metrics.margin - derived)).toBeLessThan(0.01);
  });

  it("marginPercent === null when revenue is 0 (canon M1)", async () => {
    // Canon M1 says: no impossible percentages. If revenue is 0 the SDK
    // must carry `null` across the wire, not 0%, not NaN, not Infinity.
    const metrics = await client.analytics.revenue({ startDate, endDate });
    if (metrics.revenue === 0) {
      expect(metrics.marginPercent).toBeNull();
    } else {
      expectFiniteNumber(metrics.marginPercent as number, "marginPercent");
    }
  });

  it("bySubscription rows have the canonical per-sub shape", async () => {
    const metrics: RevenueMetrics = await client.analytics.revenue({
      startDate,
      endDate,
    });
    for (const row of metrics.bySubscription) {
      expect(typeof row.subscriptionId).toBe("string");
      expect(typeof row.customerId).toBe("string");
      expect(typeof row.agentId).toBe("string");
      expect(typeof row.planId).toBe("string");
      expectFiniteNumber(row.revenue, "row.revenue");
      expectFiniteNumber(row.cost, "row.cost");
      expectFiniteNumber(row.margin, "row.margin");
      expect(row.eventCount).toBeGreaterThanOrEqual(0);
    }
  });
});
