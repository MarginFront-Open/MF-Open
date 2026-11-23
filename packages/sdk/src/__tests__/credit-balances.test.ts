/**
 * Unit tests for client.creditBalances.
 *
 * Mocks the HTTP layer and proves each method hits the right path with the
 * right verb, drops omitted filters, url-encodes the id, and surfaces the
 * server's response shape unchanged — including the two numbers that are
 * deliberately allowed to disagree (remainingUnits counts top-ups,
 * overageInProgressUnits is the invoice's top-up-blind math). The resource is
 * a pass-through by design: if it ever starts reshaping a pool number, the
 * dashboard and the SDK stop agreeing, and these equality assertions go red.
 *
 * It also pins that creditBalances is READ ONLY. Writes
 * (top-up, pause alerts) live in the dashboard, so no write verb may appear
 * on this resource by accident.
 */

import { describe, it, expect, vi } from "vitest";
import { CreditBalancesResource } from "../resources/credit-balances";
import { ValidationError } from "../errors";

function httpMock() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as any;
}

/** The exact row shape GET /v1/credit-balances returns, topped up and in
 * overage at the same time — the case the whole split exists for. */
const TOPPED_UP_AND_OVER = {
  subscriptionId: "sub-1",
  subscriptionName: "Acme pooled plan",
  customerId: "cust-1",
  customerName: "Acme",
  customerExternalId: "acme-ext",
  agentId: "agent-1",
  planId: "plan-1",
  planName: "Pooled",
  poolSizeUnits: 5000,
  consumedUnits: 5300,
  remainingUnits: 1200,
  overageInProgressUnits: 300,
  remainingPercent: 24,
  overageRatePerUnit: 0.03,
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-08-01T00:00:00.000Z",
  alertsPaused: false,
  noActivePeriod: false,
  implicitFullPool: false,
};

describe("CreditBalancesResource — list", () => {
  it("GETs /credit-balances with no filters when none are given", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      balances: [TOPPED_UP_AND_OVER],
      asOf: "2026-07-15T12:00:00.000Z",
    });
    const res = new CreditBalancesResource(http);

    const out = await res.list();

    expect(http.get).toHaveBeenCalledWith("/credit-balances", {
      customerId: undefined,
      agentId: undefined,
      belowPercent: undefined,
    });
    expect(out.balances[0]).toEqual(TOPPED_UP_AND_OVER);
  });

  it("passes customerId / agentId / belowPercent through verbatim", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      balances: [],
      asOf: "2026-07-15T12:00:00.000Z",
    });
    const res = new CreditBalancesResource(http);

    await res.list({
      customerId: "cust-1",
      agentId: "agent-1",
      belowPercent: 20,
    });

    expect(http.get).toHaveBeenCalledWith("/credit-balances", {
      customerId: "cust-1",
      agentId: "agent-1",
      belowPercent: 20,
    });
  });

  it("belowPercent 0 survives — a falsy filter is still a filter", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      balances: [],
      asOf: "2026-07-15T12:00:00.000Z",
    });
    const res = new CreditBalancesResource(http);

    await res.list({ belowPercent: 0 });

    expect(http.get.mock.calls[0][1].belowPercent).toBe(0);
  });

  it("an empty organization comes back as an empty list, never a fabricated pool", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      balances: [],
      asOf: "2026-07-15T12:00:00.000Z",
    });
    const res = new CreditBalancesResource(http);

    const out = await res.list();

    expect(out.balances).toEqual([]);
    expect(out.asOf).toBe("2026-07-15T12:00:00.000Z");
  });
});

describe("CreditBalancesResource — get", () => {
  it("GETs /subscriptions/{id}/credit-balance (id url-encoded)", async () => {
    const http = httpMock();
    http.get.mockResolvedValue(TOPPED_UP_AND_OVER);
    const res = new CreditBalancesResource(http);

    await res.get("sub 1");

    expect(http.get).toHaveBeenCalledWith(
      "/subscriptions/sub%201/credit-balance",
    );
  });

  it("throws ValidationError with an empty id, before any HTTP call", async () => {
    const http = httpMock();
    const res = new CreditBalancesResource(http);
    await expect(res.get("")).rejects.toBeInstanceOf(ValidationError);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("surfaces the server's plain-English 404 verbatim (no rewrite)", async () => {
    const http = httpMock();
    const serverMsg =
      "No credit pool found for subscription sub-1. Either the subscription doesn't " +
      "belong to this organization, or its plan doesn't sell a credit pool.";
    http.get.mockRejectedValue(new Error(serverMsg));
    const res = new CreditBalancesResource(http);

    await expect(res.get("sub-1")).rejects.toThrow(serverMsg);
  });
});

describe("CreditBalancesResource — the numbers pass through untouched", () => {
  it("keeps remainingUnits (top-up aware) and overageInProgressUnits (invoice math) BOTH", async () => {
    const http = httpMock();
    http.get.mockResolvedValue(TOPPED_UP_AND_OVER);
    const res = new CreditBalancesResource(http);

    const pool = await res.get("sub-1");

    expect(pool.remainingUnits).toBe(1200);
    expect(pool.overageInProgressUnits).toBe(300);
    // The SDK must never "reconcile" these into one number: the invoice bills
    // the second one, and a client that derives overage from remainingUnits
    // would read 0 and under-report the bill.
    expect(Math.max(0, -pool.remainingUnits)).not.toBe(
      pool.overageInProgressUnits,
    );
  });

  it("keeps an honest null period on a subscription with no billing window", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      ...TOPPED_UP_AND_OVER,
      periodStart: null,
      periodEnd: null,
      noActivePeriod: true,
      consumedUnits: 0,
    });
    const res = new CreditBalancesResource(http);

    const pool = await res.get("sub-1");

    expect(pool.periodStart).toBeNull();
    expect(pool.periodEnd).toBeNull();
    expect(pool.noActivePeriod).toBe(true);
  });

  it("keeps overageRatePerUnit null rather than coercing it to 0", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      ...TOPPED_UP_AND_OVER,
      overageRatePerUnit: null,
    });
    const res = new CreditBalancesResource(http);
    expect((await res.get("sub-1")).overageRatePerUnit).toBeNull();
  });
});

describe("CreditBalancesResource — v1 is reads only, deliberately", () => {
  it("exposes exactly list and get, and no write verb", () => {
    const methods = Object.getOwnPropertyNames(CreditBalancesResource.prototype)
      .filter((m) => m !== "constructor")
      .sort();
    expect(methods).toEqual(["get", "list"]);
  });

  it("never touches post / patch / delete on the http client", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      balances: [],
      asOf: "2026-07-15T12:00:00.000Z",
    });
    const res = new CreditBalancesResource(http);

    await res.list();
    await res.get("sub-1").catch(() => undefined);

    expect(http.post).not.toHaveBeenCalled();
    expect(http.patch).not.toHaveBeenCalled();
    expect(http.delete).not.toHaveBeenCalled();
  });
});
