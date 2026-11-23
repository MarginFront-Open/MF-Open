import { describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      throw new Error("this suite must never construct a database client");
    }
  },
}));

import { buildSampleData, type ModelPrice } from "../seed-sample-data";

const ORG = "3b0b1a2c-1111-4222-8333-444455556666";
const NOW = new Date("2026-03-10T09:30:00.000Z");
const PRICES = new Map<string, ModelPrice>([
  [
    "litellm/gpt-4.1-mini-2025-04-14",
    {
      id: "p1",
      provider: "openai",
      inputCost: 0.4,
      outputCost: 1.6,
      costUnit: "1M tokens",
    },
  ],
  [
    "litellm/claude-sonnet-4-5",
    {
      id: "p2",
      provider: "anthropic",
      inputCost: 3,
      outputCost: 15,
      costUnit: "1M tokens",
    },
  ],
]);

const dates = (rows: Record<string, unknown>[], field: string) =>
  rows.map((row) => row[field] as Date);

describe("buildSampleData", () => {
  const data = buildSampleData(ORG, NOW, PRICES);

  it("writes the same ids on every run for one organization, and different ids for another", () => {
    const again = buildSampleData(
      ORG,
      new Date("2026-07-01T00:00:00Z"),
      PRICES,
    );
    const other = buildSampleData(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      NOW,
      PRICES,
    );
    const ids = (d: typeof data) =>
      Object.values(d)
        .flat()
        .map((row) => row.id);
    expect(ids(again)).toEqual(ids(data));
    expect(new Set(ids(data)).size).toBe(ids(data).length);
    expect(ids(other).some((id) => ids(data).includes(id))).toBe(false);
  });

  it("dates every event and invoice in the past, relative to now", () => {
    const eventDates = dates(data.signal_events, "usageDate");
    expect(Math.max(...eventDates.map(Number))).toBeLessThan(+NOW);
    expect(eventDates.map((d) => d.toISOString().slice(0, 10))).toContain(
      "2026-03-09",
    );
    expect(
      dates(data.invoices, "invoiceDate")
        .map((d) => d.toISOString().slice(0, 10))
        .sort(),
    ).toEqual([
      "2026-02-01",
      "2026-02-01",
      "2026-02-01",
      "2026-03-01",
      "2026-03-01",
      "2026-03-01",
    ]);
  });

  it("uses only example.com addresses", () => {
    for (const customer of data.customers) {
      expect(customer.email).toMatch(/@[a-z]+\.example\.com$/);
    }
  });

  it("bills each usage line for exactly the units the events in that month carry", () => {
    for (const line of data.invoice_line_items.filter(
      (l) => l.type === "usage",
    )) {
      const invoice = data.invoices.find((i) => i.id === line.invoiceId)!;
      const signal = data.signals.find((s) => s.name === line.description)!;
      const units = data.signal_events
        .filter(
          (e) =>
            e.customerId === invoice.customerId && e.signalId === signal.id,
        )
        .filter(
          (e) =>
            e.usageDate >= invoice.billingPeriodStart! &&
            e.usageDate <= invoice.billingPeriodEnd!,
        )
        .reduce((sum, e) => sum + (e.quantity as number), 0);
      expect(line.quantity).toBe(units);
    }
  });

  it("prices each event with the catalog rate and records a payment for every paid invoice", () => {
    const event = data.signal_event_services[0];
    expect(event.usageCost).toBeCloseTo(
      ((event.inputTokens as number) * 0.4 +
        (event.outputTokens as number) * 1.6) /
        1e6,
      10,
    );
    const paid = data.invoices
      .filter((i) => i.status === "paid")
      .map((i) => i.id);
    expect(data.invoice_payments.map((p) => p.invoiceId).sort()).toEqual(
      paid.sort(),
    );
  });
});
