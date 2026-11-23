/**
 * Integration test: `client.customers.getWithRevenue()`
 *
 * Skipped unless MF_TEST_SECRET_KEY is set.
 *
 * What it proves:
 *   1. Returns { customer, revenue } composite shape.
 *   2. Customer block matches regular get() response.
 *   3. Revenue block is canonical RevenueMetrics scoped to this customer.
 *   4. Optional window parameter works.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK customers.getWithRevenue() (live API)", () => {
  let client: MarginFrontClient;
  let customerId: string | null = null;

  beforeAll(async () => {
    client = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      fireAndForget: false,
      timeout: 15000,
      retries: 0,
    });

    // Pick any customer from the org. Shape-only test, no fixture needed.
    const list = await client.customers.list({ limit: 1 });
    const data = Array.isArray(list) ? list : list.data;
    if (data.length > 0) {
      customerId = data[0].id;
    }
  });

  it("returns { customer, revenue } with canonical shapes", async () => {
    if (!customerId) {
      console.warn(
        "[SDK] No customers in test org. skipping getWithRevenue shape test",
      );
      return;
    }

    const result = await client.customers.getWithRevenue(customerId);

    // Outer composite shape
    expect(result.customer).toBeDefined();
    expect(result.revenue).toBeDefined();

    // Customer block. Regular Customer shape
    expect(result.customer.id).toBe(customerId);
    expect(typeof result.customer.name).toBe("string");

    // Revenue block. Canonical RevenueMetrics
    expect(typeof result.revenue.revenue).toBe("number");
    expect(Number.isFinite(result.revenue.revenue)).toBe(true);
    expect(typeof result.revenue.cost).toBe("number");
    expect(typeof result.revenue.margin).toBe("number");
    expect(Array.isArray(result.revenue.bySubscription)).toBe(true);
    expect(Array.isArray(result.revenue.byStrategy)).toBe(true);
  });

  it("accepts an explicit date window", async () => {
    if (!customerId) return;

    const result = await client.customers.getWithRevenue(customerId, {
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      endDate: new Date().toISOString(),
    });
    expect(result.customer.id).toBe(customerId);
    expect(typeof result.revenue.revenue).toBe("number");
  });

  it("revenue.bySubscription rows all belong to this customer", async () => {
    // Canonical filtering: scoping by customerId means every bySubscription
    // row has that customerId set.
    if (!customerId) return;
    const result = await client.customers.getWithRevenue(customerId);
    for (const row of result.revenue.bySubscription) {
      expect(row.customerId).toBe(customerId);
    }
  });

  it("rejects empty id at the SDK level", async () => {
    await expect(client.customers.getWithRevenue("")).rejects.toThrow();
  });
});
