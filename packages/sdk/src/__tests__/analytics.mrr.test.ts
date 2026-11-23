/**
 * Integration test: all three MRR variants via the SDK
 *
 * Covers `client.analytics.mrr()`, `runRateMrr()`, `committedMrr()`.
 * Skipped unless MF_TEST_SECRET_KEY is set.
 *
 * What it proves:
 *   1. MRR1 (canonical): returns { mrr, arr }. no breakdown.
 *   2. MRR2 (run-rate): returns { mrr, breakdown[] } with per-sub rows.
 *   3. MRR3 (committed): same shape as run-rate, contractual floor only.
 *   4. Invariant: committed ≤ runRate (floor ≤ trajectory) canonical
 *      relationship, assuming both query the same scope at the same time.
 *   5. arr === mrr × 12 in the canonical MRR1 response.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK analytics MRR variants (live API)", () => {
  let client: MarginFrontClient;

  beforeAll(() => {
    client = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      fireAndForget: false,
      timeout: 15000,
      retries: 0,
    });
  });

  // ──────────────────────────────────────────────────────────────
  // MRR1. Canonical (contracted monthly recurring revenue, today)
  // ──────────────────────────────────────────────────────────────
  it("mrr() returns { mrr, arr } with arr === mrr * 12", async () => {
    const result = await client.analytics.mrr();
    expect(typeof result.mrr).toBe("number");
    expect(typeof result.arr).toBe("number");
    expect(Number.isFinite(result.mrr)).toBe(true);
    expect(Number.isFinite(result.arr)).toBe(true);

    // Independent recompute. Canon guarantees arr = mrr * 12 exactly.
    // A tolerance below one cent is safe given JS float representation.
    expect(Math.abs(result.arr - result.mrr * 12)).toBeLessThan(0.01);
  });

  it("mrr() carries no `variant` field in the returned object", async () => {
    // The API wraps the result with a variant discriminator internally;
    // the SDK must strip it so the consumer sees `Mrr` cleanly.
    const result = (await client.analytics.mrr()) as unknown as Record<
      string,
      unknown
    >;
    expect(result.variant).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────
  // MRR2. Run-rate (last 30 days × 1-month projection)
  // ──────────────────────────────────────────────────────────────
  it("runRateMrr() returns { mrr, breakdown[] } with canonical row shape", async () => {
    const result = await client.analytics.runRateMrr();
    expect(typeof result.mrr).toBe("number");
    expect(Array.isArray(result.breakdown)).toBe(true);

    for (const row of result.breakdown) {
      expect(typeof row.subscriptionId).toBe("string");
      expect(typeof row.customerId).toBe("string");
      expect(typeof row.agentId).toBe("string");
      expect(typeof row.planId).toBe("string");
      expect(typeof row.recurring).toBe("number");
      expect(typeof row.seatBased).toBe("number");
      expect(typeof row.usage).toBe("number");
      expect(typeof row.total).toBe("number");

      // total === recurring + seatBased + usage per canon MRR2 invariant.
      const derived = row.recurring + row.seatBased + row.usage;
      expect(Math.abs(row.total - derived)).toBeLessThan(0.01);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // MRR3. Committed (contractual floor)
  // ──────────────────────────────────────────────────────────────
  it("committedMrr() returns same shape as run-rate, floor value", async () => {
    const result = await client.analytics.committedMrr();
    expect(typeof result.mrr).toBe("number");
    expect(Array.isArray(result.breakdown)).toBe(true);

    for (const row of result.breakdown) {
      expect(typeof row.subscriptionId).toBe("string");
      expect(typeof row.recurring).toBe("number");
      expect(typeof row.seatBased).toBe("number");
      expect(typeof row.usage).toBe("number");
      expect(typeof row.total).toBe("number");
      // Usage floor can't be negative. It's calcRouted(strategy, minCommit)
      // with minCommit always ≥ 0.
      expect(row.usage).toBeGreaterThanOrEqual(0);
    }
  });

  it("committed MRR ≤ run-rate MRR (floor ≤ trajectory)", async () => {
    // Canonical invariant: committed represents the floor (usage replaced
    // with minCommit); run-rate uses actual usage which is always ≥ min.
    // Narrow tolerance because same-instant queries shouldn't drift.
    const [committed, runRate] = await Promise.all([
      client.analytics.committedMrr(),
      client.analytics.runRateMrr(),
    ]);
    expect(committed.mrr).toBeLessThanOrEqual(runRate.mrr + 0.01);
  });
});
