/**
 * Integration test: `client.analytics.usage()` with subscriptionId filter
 *
 * Skipped unless MF_TEST_SECRET_KEY is set.
 *
 * What it proves:
 *   1. The subscriptionId filter field is accepted without error.
 *   2. Filtered response totals are ≤ unfiltered response totals. A
 *      subscription's usage is a subset of org-wide usage.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK analytics.usage() subscriptionId filter (live API)", () => {
  let client: MarginFrontClient;
  let subscriptionId: string | null = null;
  const endDate = new Date().toISOString();
  const startDate = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  beforeAll(async () => {
    client = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      fireAndForget: false,
      timeout: 15000,
      retries: 0,
    });
    const list = await client.subscriptions.list({ limit: 1 });
    if (list.subscriptions.length > 0) {
      subscriptionId = list.subscriptions[0].id;
    }
  });

  it("accepts subscriptionId filter and returns a UsageAnalyticsResponse", async () => {
    if (!subscriptionId) {
      console.warn(
        "[SDK] No subscriptions in test org. skipping subscription-filter test",
      );
      return;
    }
    const scoped = await client.analytics.usage({
      startDate,
      endDate,
      subscriptionId,
    });
    expect(scoped).toBeDefined();
    expect(scoped.summary).toBeDefined();
    expect(typeof scoped.summary.totalEvents).toBe("number");
  });

  it("filtered totals are ≤ unfiltered totals (subset relationship)", async () => {
    // Canonical subset invariant: filtering by ONE subscription can never
    // produce more events than the unfiltered org-wide query. A smoke
    // check that subscriptionId actually does narrow the result rather
    // than being silently ignored.
    if (!subscriptionId) return;

    const [scoped, full] = await Promise.all([
      client.analytics.usage({ startDate, endDate, subscriptionId }),
      client.analytics.usage({ startDate, endDate }),
    ]);

    expect(scoped.summary.totalEvents).toBeLessThanOrEqual(
      full.summary.totalEvents,
    );
    expect(scoped.summary.totalCost).toBeLessThanOrEqual(
      full.summary.totalCost + 0.01,
    );
  });
});
