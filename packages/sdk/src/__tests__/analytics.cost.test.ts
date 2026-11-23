/**
 * Integration test: `client.analytics.costBreakdown()`
 *
 * Live-API test. Skipped unless MF_TEST_SECRET_KEY is set.
 *
 * What it proves:
 *   1. CostMetrics top-level shape (cost, eventCount, breakdowns).
 *   2. All six breakdown arrays are present (even when empty).
 *   3. `includePriorWindow: true` populates `prior` with the same shape.
 *   4. `includePriorWindow: false` leaves `prior` undefined.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK analytics.costBreakdown() (live API)", () => {
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

  it("returns canonical CostMetrics shape (all six breakdown arrays)", async () => {
    const cost = await client.analytics.costBreakdown({ startDate, endDate });

    expect(typeof cost.cost).toBe("number");
    expect(Number.isFinite(cost.cost)).toBe(true);
    expect(cost.eventCount).toBeGreaterThanOrEqual(0);
    expect(cost.eventCountWithNullCost).toBeGreaterThanOrEqual(0);

    // eventCountWithNullCost is a subset counter. It can never exceed
    // the total event count. Canon C1 invariant.
    expect(cost.eventCountWithNullCost).toBeLessThanOrEqual(cost.eventCount);

    // Every breakdown array must be present (empty is fine; undefined is not).
    expect(Array.isArray(cost.byAgent)).toBe(true);
    expect(Array.isArray(cost.byCustomer)).toBe(true);
    expect(Array.isArray(cost.bySignal)).toBe(true);
    expect(Array.isArray(cost.byDay)).toBe(true);
    expect(Array.isArray(cost.byPlan)).toBe(true);
    expect(Array.isArray(cost.byModel)).toBe(true);
  });

  it("omits `prior` when includePriorWindow is false (default)", async () => {
    const cost = await client.analytics.costBreakdown({ startDate, endDate });
    expect(cost.prior).toBeUndefined();
  });

  it("populates `prior` with matching shape when includePriorWindow is true", async () => {
    const cost = await client.analytics.costBreakdown({
      startDate,
      endDate,
      includePriorWindow: true,
    });
    expect(cost.prior).toBeDefined();
    if (!cost.prior) return; // narrowing for TS
    expect(typeof cost.prior.cost).toBe("number");
    expect(cost.prior.eventCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(cost.prior.byAgent)).toBe(true);
    expect(Array.isArray(cost.prior.byDay)).toBe(true);
  });

  it("byDay rows carry an ISO-string date and non-negative numbers", async () => {
    const cost = await client.analytics.costBreakdown({ startDate, endDate });
    for (const row of cost.byDay) {
      // Date is serialized as ISO string across JSON. `typeof === 'string'`
      // AND it must parse via Date without producing NaN.
      expect(typeof row.date).toBe("string");
      expect(Number.isFinite(new Date(row.date).getTime())).toBe(true);
      expect(row.cost).toBeGreaterThanOrEqual(0);
      expect(row.eventCount).toBeGreaterThanOrEqual(0);
    }
  });
});
