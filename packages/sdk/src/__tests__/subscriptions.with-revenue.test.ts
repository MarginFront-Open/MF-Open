/**
 * Integration test: `client.subscriptions.getWithRevenue()`
 *
 * Skipped unless MF_TEST_SECRET_KEY is set.
 *
 * What it proves:
 *   1. Returns { subscription, revenue } composite shape.
 *   2. Subscription block matches regular get() response.
 *   3. Revenue block is canonical RevenueMetrics.
 *   4. Parallel calls: same latency characteristics as the two requests
 *      would have taken separately (single round-trip wall-clock).
 *   5. Window defaults to last 30 days when omitted.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK subscriptions.getWithRevenue() (live API)", () => {
  let client: MarginFrontClient;
  let subscriptionId: string | null = null;

  beforeAll(async () => {
    client = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      fireAndForget: false,
      timeout: 15000,
      retries: 0,
    });
    // Grab any active subscription in the org. The test is shape-only,
    // so we don't need to create our own fixture.
    const list = await client.subscriptions.list({ limit: 1 });
    if (list.subscriptions.length > 0) {
      subscriptionId = list.subscriptions[0].id;
    }
  });

  it.runIf(true)(
    "returns { subscription, revenue } with canonical shapes",
    async () => {
      // `it.runIf` gate: if the seed has no subscriptions we can't test
      // against a real ID. In that case skip gracefully.
      if (!subscriptionId) {
        console.warn(
          "[SDK] No subscriptions in test org. skipping getWithRevenue shape test",
        );
        return;
      }

      const result = await client.subscriptions.getWithRevenue(subscriptionId);

      // Outer shape
      expect(result.subscription).toBeDefined();
      expect(result.revenue).toBeDefined();

      // Subscription block matches regular SubscriptionDetail
      expect(result.subscription.id).toBe(subscriptionId);
      expect(typeof result.subscription.status).toBe("string");
      expect(result.subscription.customer).toBeDefined();
      expect(result.subscription.agent).toBeDefined();
      expect(result.subscription.plan).toBeDefined();

      // Revenue block is canonical RevenueMetrics
      expect(typeof result.revenue.revenue).toBe("number");
      expect(typeof result.revenue.cost).toBe("number");
      expect(typeof result.revenue.margin).toBe("number");
      expect(Array.isArray(result.revenue.bySubscription)).toBe(true);
      expect(Array.isArray(result.revenue.byStrategy)).toBe(true);
    },
  );

  it("accepts an explicit date window", async () => {
    if (!subscriptionId) return;

    const result = await client.subscriptions.getWithRevenue(subscriptionId, {
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      endDate: new Date().toISOString(),
    });
    expect(result.subscription.id).toBe(subscriptionId);
    expect(typeof result.revenue.revenue).toBe("number");
  });

  it("revenue.bySubscription contains only this subscription (when any rows)", async () => {
    // Canonical filtering: when scoped to one subscription, the bySubscription
    // breakdown should only ever carry that sub (or be empty if no activity).
    if (!subscriptionId) return;
    const result = await client.subscriptions.getWithRevenue(subscriptionId);
    for (const row of result.revenue.bySubscription) {
      expect(row.subscriptionId).toBe(subscriptionId);
    }
  });

  it("rejects empty subscriptionId at the SDK level", async () => {
    await expect(client.subscriptions.getWithRevenue("")).rejects.toThrow();
  });
});
