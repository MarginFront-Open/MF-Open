/**
 * Integration test: `client.analytics.invoiceTotals()`
 *
 * Skipped unless MF_TEST_SECRET_KEY is set.
 *
 * What it proves:
 *   1. Shape: billed, collected, draft, outstanding, overdueAmount,
 *      overdueCount, invoicesSentCount. All present, all correct types.
 *   2. Canon invariant: outstanding is current-state open A/R —
 *      always >= 0 and always >= overdueAmount (overdue is the past-due subset).
 *      It is NOT billed - collected: billed is accrual (invoiceDate) and
 *      collected is cash (paymentDate), so the subtraction could go
 *      negative.
 *   3. overdueCount is a non-negative integer.
 *   4. overdueAmount is always non-negative.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK analytics.invoiceTotals() (live API)", () => {
  let client: MarginFrontClient;
  const endDate = new Date().toISOString();
  const startDate = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000,
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

  it("returns canonical InvoiceTotals shape (seven fields)", async () => {
    const totals = await client.analytics.invoiceTotals({ startDate, endDate });

    expect(typeof totals.billed).toBe("number");
    expect(typeof totals.collected).toBe("number");
    expect(typeof totals.draft).toBe("number");
    expect(typeof totals.outstanding).toBe("number");
    expect(typeof totals.overdueAmount).toBe("number");
    expect(typeof totals.overdueCount).toBe("number");
    expect(typeof totals.invoicesSentCount).toBe("number");

    // Every money field must be finite.
    expect(Number.isFinite(totals.billed)).toBe(true);
    expect(Number.isFinite(totals.collected)).toBe(true);
    expect(Number.isFinite(totals.outstanding)).toBe(true);
  });

  it("outstanding is current-state open A/R: >= 0 and >= overdue", async () => {
    // Outstanding is open accounts-receivable RIGHT NOW (issued + overdue), not
    // billed - collected: billed is accrual (invoiceDate) and collected is cash
    // (paymentDate), different bases, so that subtraction could go negative.
    // Open A/R is always non-negative and always >= overdueAmount (overdue is
    // the past-due subset of what's open).
    const totals = await client.analytics.invoiceTotals({ startDate, endDate });
    expect(totals.outstanding).toBeGreaterThanOrEqual(0);
    expect(totals.outstanding + 0.01).toBeGreaterThanOrEqual(totals.overdueAmount);
  });

  it("overdue and count fields are non-negative integers", async () => {
    const totals = await client.analytics.invoiceTotals({ startDate, endDate });
    expect(totals.overdueAmount).toBeGreaterThanOrEqual(0);
    expect(totals.overdueCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(totals.overdueCount)).toBe(true);
    expect(totals.invoicesSentCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(totals.invoicesSentCount)).toBe(true);
  });
});
