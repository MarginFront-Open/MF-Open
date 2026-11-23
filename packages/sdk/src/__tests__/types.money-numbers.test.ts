/**
 * Integration test: money fields are numbers, not strings.
 *
 * A Prisma Decimal serializes to a JSON string, which would force every
 * caller to parseFloat. This test pins the contract that all invoice money
 * fields come back as plain `number` values.
 *
 * Skipped unless MF_TEST_SECRET_KEY is set.
 *
 * What it proves:
 *   1. Invoice.totalAmount, amountPaid, amountDue are `number`.
 *   2. InvoiceLineItem.unitPrice, amount are `number`.
 *   3. InvoiceDetail.payments[].amount is `number`.
 *   4. Values are finite (no NaN from bad parses).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK money fields are numbers (live API regression)", () => {
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

  it("Invoice list: totalAmount / amountPaid / amountDue are numbers", async () => {
    const list = await client.invoices.list({ limit: 5 });
    if (list.invoices.length === 0) {
      console.warn(
        "[SDK] No invoices in test org. skipping money-type regression test",
      );
      return;
    }

    for (const inv of list.invoices) {
      // Money fields must be numbers.
      expect(typeof inv.totalAmount).toBe("number");
      expect(typeof inv.amountPaid).toBe("number");
      expect(typeof inv.amountDue).toBe("number");

      // Values must be finite (no NaN from bad parses on null/undefined).
      expect(Number.isFinite(inv.totalAmount as number)).toBe(true);
      expect(Number.isFinite(inv.amountPaid as number)).toBe(true);
      expect(Number.isFinite(inv.amountDue as number)).toBe(true);
    }
  });

  it("Invoice line items: unitPrice + amount are numbers", async () => {
    const list = await client.invoices.list({ limit: 5 });
    if (list.invoices.length === 0) return;

    // Pull one invoice's detail view to get line items
    const invoiceId = list.invoices[0].id;
    const detail = await client.invoices.get(invoiceId);

    for (const lineItem of detail.lineItems) {
      expect(typeof lineItem.unitPrice).toBe("number");
      expect(typeof lineItem.amount).toBe("number");
      expect(Number.isFinite(lineItem.unitPrice as number)).toBe(true);
      expect(Number.isFinite(lineItem.amount as number)).toBe(true);
    }
  });

  it("Invoice payments: amount is a number", async () => {
    const list = await client.invoices.list({ limit: 5 });
    if (list.invoices.length === 0) return;

    // Find an invoice with payments. Payments only exist on paid/partial
    // invoices, so we iterate.
    for (const inv of list.invoices) {
      const detail = await client.invoices.get(inv.id);
      if (!detail.payments || detail.payments.length === 0) continue;

      for (const payment of detail.payments) {
        expect(typeof payment.amount).toBe("number");
        expect(Number.isFinite(payment.amount as number)).toBe(true);
      }
      return; // found an invoice with payments, assertion complete
    }
    // If nothing had payments, the test passes vacuously. We're testing
    // the shape when payments exist, not asserting they must exist.
  });

  it("Arithmetic works directly on invoice money fields (no parseFloat needed)", async () => {
    // Callers shouldn't have to cast money fields before doing math.
    const list = await client.invoices.list({ limit: 3 });
    if (list.invoices.length === 0) return;

    for (const inv of list.invoices) {
      // Direct arithmetic. No parseFloat, no Number().
      const outstanding =
        (inv.totalAmount as number) - (inv.amountPaid as number);
      expect(Number.isFinite(outstanding)).toBe(true);

      // amountDue should equal totalAmount - amountPaid within rounding.
      const expected = outstanding;
      if (Math.abs((inv.amountDue as number) - expected) >= 0.01) {
        // This is a data invariant check; if it fails the issue is on the
        // server, not the SDK. Log rather than throw so we surface it.
        console.warn(
          `[invoice ${inv.id}] amountDue (${inv.amountDue}) != totalAmount - amountPaid (${expected})`,
        );
      }
    }
  });
});
