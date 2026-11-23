/**
 * Fills the one organization in this database with invented sample data, so a
 * new install opens on populated pages: two agents, two plans, three customers
 * with subscriptions, about three months of usage events, and two months of
 * invoices and payments. Every date is relative to the moment it runs.
 *
 * Every row id is derived from the organization id, so a second run deletes the
 * rows the first run wrote and writes them again with fresh dates. It never
 * touches a row it did not write.
 *
 * Usage (from the repository root): npm run db:seed-sample
 */

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { calculateEventCost } from "../src/lib/model-pricing";
import { loadPackageEnvFile, requireDatabaseUrl } from "./package-env";

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_DAYS = 95;
const AGENTS = { support: "Support Assistant", research: "Research Assistant" };

// key -> [name, agent, price catalog id, input tokens, output tokens] per unit
const SIGNALS: Record<string, [string, string, string, number, number]> = {
  ticket: [
    "Ticket resolved",
    "support",
    "litellm/gpt-4.1-mini-2025-04-14",
    1800,
    600,
  ],
  report: [
    "Report drafted",
    "research",
    "litellm/claude-sonnet-4-5",
    12e3,
    35e2,
  ],
};

// key -> [name, monthly fee, price per unit of each signal]
const PLANS: Record<string, [string, number, Record<string, number>]> = {
  starter: ["Starter", 49, { ticket: 0.5 }],
  pro: ["Pro", 199, { ticket: 0.4, report: 4 }],
};

// key -> [name, plan, units of each signal per day]
const CUSTOMERS: Record<string, [string, string, Record<string, number>]> = {
  bakery: ["Sample Bakery Co", "starter", { ticket: 3 }],
  freight: ["Sample Freight Ltd", "pro", { ticket: 6, report: 1 }],
  dental: ["Sample Dental Group", "pro", { ticket: 4, report: 2 }],
};

export interface ModelPrice {
  id: string;
  provider: string;
  inputCost: number;
  outputCost: number;
  costUnit: string;
}

type Row = Record<string, unknown>;

export function sampleId(organizationId: string, key: string): string {
  const h = createHash("sha1").update(`${organizationId}:${key}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const parts = [h.slice(0, 8), h.slice(8, 12), `5${h.slice(13, 16)}`];
  return [...parts, `${variant}${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
}

const monthStart = (now: Date, offset: number) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
const cents = (value: number) => Math.round(value * 100) / 100;

export function buildSampleData(
  orgId: string,
  now: Date,
  prices: Map<string, ModelPrice>,
) {
  const id = (key: string) => sampleId(orgId, `sample:${key}`);
  const organizationId = orgId;
  const stamp = { createdAt: monthStart(now, -3), updatedAt: now };
  const nextMonth = monthStart(now, 1);

  const agents = Object.entries(AGENTS).map(([key, name]) => ({
    ...{ id: id(`agent:${key}`), name, agentCode: `sample-${key}` },
    ...{ orgId, ...stamp },
  }));
  const signals = Object.entries(SIGNALS).map(([key, [name, agent]]) => ({
    ...{ id: id(`signal:${key}`), name, shortName: key, orgId, ...stamp },
    agentId: id(`agent:${agent}`),
  }));
  const plans = Object.entries(PLANS).map(([key, [name]]) => ({
    ...{ id: id(`plan:${key}`), name, orgId, ...stamp },
  }));
  const agentPlans: Row[] = [];
  const strategies: Row[] = [];
  for (const [planKey, [planName, fee, rates]] of Object.entries(PLANS)) {
    const planId = id(`plan:${planKey}`);
    const common = { planId, orgId, billingFrequency: "monthly", ...stamp };
    strategies.push({
      ...{ ...common, id: id(`fee:${planKey}`), agentId: id("agent:support") },
      ...{
        name: `${planName} monthly fee`,
        chargeType: "recurring",
        rate: fee,
      },
    });
    for (const [signalKey, rate] of Object.entries(rates)) {
      const [name, agent] = SIGNALS[signalKey];
      const agentId = id(`agent:${agent}`);
      const link = id(`agent-plan:${planKey}:${agent}`);
      agentPlans.push({ id: link, agentId, planId });
      strategies.push({
        ...{ ...common, id: id(`strategy:${planKey}:${signalKey}`), agentId },
        ...{ name: `${name}, per unit`, signalId: id(`signal:${signalKey}`) },
        ...{ chargeType: "usage", pricingModel: "flat", rate },
      });
    }
  }

  const customers = Object.entries(CUSTOMERS).map(([key, [name]]) => ({
    ...{ id: id(`customer:${key}`), name, externalId: `sample-${key}` },
    ...{ email: `billing@${key}.example.com`, organizationId, ...stamp },
  }));
  const subscriptions = Object.entries(CUSTOMERS).map(
    ([key, [name, plan]]) => ({
      ...{ id: id(`subscription:${key}`), name: `${name}: ${PLANS[plan][0]}` },
      ...{ customerId: id(`customer:${key}`), planId: id(`plan:${plan}`) },
      ...{ agentId: id("agent:support"), organizationId, ...stamp },
      ...{
        startDate: monthStart(now, -3),
        status: "active",
        billingModel: "hybrid",
      },
      ...{ nextRecurringInvoiceAt: nextMonth, nextUsageInvoiceAt: nextMonth },
    }),
  );

  const rawEvents: Row[] = [];
  const events: Row[] = [];
  const children: Row[] = [];
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  for (let day = EVENT_DAYS; day >= 1; day -= 1) {
    const usageDate = new Date(today - day * DAY_MS + 15 * 60 * 60 * 1000);
    const at = { createdAt: usageDate, updatedAt: usageDate };
    for (const [customerKey, [, , perDay]] of Object.entries(CUSTOMERS)) {
      for (const [signalKey, base] of Object.entries(perDay)) {
        const [signalName, agent, catalogId, input, output] =
          SIGNALS[signalKey];
        const price = prices.get(catalogId);
        if (!price) throw new Error(`No price was loaded for ${catalogId}.`);
        const quantity = base + (day % 3);
        const [inputTokens, outputTokens] = [input, output].map(
          (tokens) => tokens * quantity,
        );
        const usageCost = calculateEventCost(
          inputTokens,
          outputTokens,
          quantity,
          price,
        ).totalCostUsd.toNumber();
        const key = `${customerKey}:${signalKey}:${day}`;
        const customerExternalId = `sample-${customerKey}`;
        const usage = { inputTokens, outputTokens, quantity };
        const service = {
          model: catalogId.split("/")[1],
          modelProvider: price.provider,
        };
        rawEvents.push({
          ...{ id: id(`raw:${key}`), organizationId, status: "PROCESSED" },
          payload: { customerExternalId, signalName, ...service, ...usage },
          ...{ receivedAt: usageDate, ...at },
        });
        events.push({
          ...{ id: id(`event:${key}`), rawIngestEventId: id(`raw:${key}`) },
          ...{ organizationId, customerExternalId, usageDate, ...at },
          customerId: id(`customer:${customerKey}`),
          subscriptionId: id(`subscription:${customerKey}`),
          agentId: id(`agent:${agent}`),
          signalId: id(`signal:${signalKey}`),
          ...{ quantity, usageCost, eventProcessed: "PROCESSED" },
        });
        children.push({
          ...{ id: id(`service:${key}`), signalEventId: id(`event:${key}`) },
          ...{ ...service, ...usage, servicePricingId: price.id },
          ...{ usageCost, eventStatus: "PROCESSED" },
        });
      }
    }
  }

  const invoices: Row[] = [];
  const lineItems: Row[] = [];
  const payments: Row[] = [];
  for (const monthsAgo of [2, 1]) {
    const start = monthStart(now, -monthsAgo);
    const end = monthStart(now, 1 - monthsAgo);
    for (const [customerKey, [, planKey]] of Object.entries(CUSTOMERS)) {
      const [planName, fee, rates] = PLANS[planKey];
      const invoiceId = id(`invoice:${customerKey}:${monthsAgo}`);
      const lines = [
        { description: `${planName} monthly fee`, quantity: 1, unitPrice: fee },
      ];
      for (const [signalKey, unitPrice] of Object.entries(rates)) {
        const quantity = events
          .filter((e) => e.customerId === id(`customer:${customerKey}`))
          .filter((e) => e.signalId === id(`signal:${signalKey}`))
          .filter((e) => (e.usageDate as Date) >= start)
          .filter((e) => (e.usageDate as Date) < end)
          .reduce((sum, e) => sum + (e.quantity as number), 0);
        const description = SIGNALS[signalKey][0];
        if (quantity > 0) lines.push({ description, quantity, unitPrice });
      }
      const total = cents(
        lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0),
      );
      const paid = monthsAgo === 2 || customerKey === "bakery";
      invoices.push({
        ...{ id: invoiceId, organizationId, createdAt: end, updatedAt: now },
        customerId: id(`customer:${customerKey}`),
        subscriptionId: id(`subscription:${customerKey}`),
        invoiceNumber: `SAMPLE-${start.toISOString().slice(0, 7)}-${customerKey}`,
        ...{ invoiceDate: end, dueDate: new Date(end.getTime() + 30 * DAY_MS) },
        billingPeriodStart: start,
        billingPeriodEnd: new Date(end.getTime() - 1),
        status: paid ? "paid" : "issued",
        ...{ subtotal: total, totalAmount: total },
        ...{ amountPaid: paid ? total : 0, amountDue: paid ? 0 : total },
      });
      lines.forEach((line, i) =>
        lineItems.push({
          ...{ ...line, id: id(`line:${customerKey}:${monthsAgo}:${i}`) },
          ...{ invoiceId, amount: cents(line.quantity * line.unitPrice) },
          ...{ type: i === 0 ? "recurring" : "usage", ...stamp },
        }),
      );
      const paidAt = new Date(Math.min(end.getTime() + 5 * DAY_MS, +now));
      if (paid) {
        payments.push({
          ...{ id: id(`payment:${customerKey}:${monthsAgo}`), invoiceId },
          ...{ amount: total, paymentDate: paidAt, paymentMethod: "ach" },
          ...{ createdAt: paidAt, updatedAt: paidAt },
        });
      }
    }
  }

  // Keys are table names, in the order the rows must be written.
  return {
    agents,
    signals,
    pricing_plans: plans,
    agent_pricing_plans: agentPlans,
    pricing_strategies: strategies,
    customers,
    subscriptions,
    raw_ingest_events: rawEvents,
    signal_events: events,
    signal_event_services: children,
    invoices,
    invoice_line_items: lineItems,
    invoice_payments: payments,
  };
}

export type SampleData = ReturnType<typeof buildSampleData>;

type Table = {
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>;
  createMany(args: { data: Row[] }): Promise<unknown>;
};

export async function writeSampleData(
  prisma: PrismaClient,
  data: SampleData,
): Promise<void> {
  const tables = Object.entries(data) as [string, Row[]][];
  await prisma.$transaction(
    async (tx) => {
      const table = (name: string) =>
        (tx as unknown as Record<string, Table>)[name];
      for (const [name, rows] of [...tables].reverse()) {
        const ids = rows.map((row) => row.id as string);
        await table(name).deleteMany({ where: { id: { in: ids } } });
      }
      for (const [name, rows] of tables) {
        await table(name).createMany({ data: rows });
      }
    },
    { timeout: 120_000 },
  );
}

export async function loadPrices(prisma: PrismaClient) {
  const wanted = Object.values(SIGNALS).map((signal) => signal[2]);
  const rows = await prisma.service_pricing.findMany({
    where: { externalId: { in: wanted }, isActive: true },
  });
  const prices = new Map<string, ModelPrice>();
  for (const r of rows) {
    prices.set(r.externalId, {
      ...{ id: r.id, provider: r.provider, costUnit: r.costUnit },
      inputCost: Number(r.inputCost ?? 0),
      outputCost: Number(r.outputCost ?? 0),
    });
  }
  const missing = wanted.filter((catalogId) => !prices.has(catalogId));
  if (missing.length > 0) {
    throw new Error(
      `The price catalog has no active row for ${missing.join(" and ")}, ` +
        "so the sample events can't be priced. The prices were probably " +
        "never loaded. Fix: run `npm run db:setup`, then run this again. " +
        "Nothing was changed.",
    );
  }
  return prices;
}

export async function main(): Promise<void> {
  loadPackageEnvFile();
  requireDatabaseUrl();
  const prisma = new PrismaClient();
  try {
    const orgs = await prisma.organizations.findMany({
      select: { id: true, name: true },
    });
    if (orgs.length !== 1) {
      throw new Error(
        orgs.length === 0
          ? "There is no organization to fill yet. Fix: sign up in the " +
              "dashboard, which creates your organization, then run this " +
              "again. Nothing was changed."
          : `This database has ${orgs.length} organizations. The sample data ` +
              "only goes into a database with exactly one, so it can't pick " +
              "for you. Nothing was changed.",
      );
    }
    const prices = await loadPrices(prisma);
    const data = buildSampleData(orgs[0].id, new Date(), prices);
    await writeSampleData(prisma, data);
    console.log(
      `Sample data written to "${orgs[0].name}": ` +
        `${data.customers.length} customers, ${data.agents.length} agents, ` +
        `${data.pricing_plans.length} plans, ` +
        `${data.signal_events.length} usage events, ` +
        `${data.invoices.length} invoices.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
