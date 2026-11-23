/**
 * Unit tests for client.spendControls.
 *
 * Mocks the HTTP layer and proves each method hits the right /control/* path
 * with the right verb, drops an omitted dev filter, url-encodes the id, and
 * surfaces the server's response shape unchanged (including honest-null spend).
 * It also proves a server error message reaches the caller verbatim — the SDK
 * never rewrites the plain-English 403 the write endpoints return.
 */

import { describe, it, expect, vi } from "vitest";
import { SpendControlsResource } from "../resources/spend-controls";
import { ValidationError } from "../errors";

function httpMock() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as any;
}

describe("SpendControlsResource — reads", () => {
  it("list() GETs /control/caps", async () => {
    const http = httpMock();
    http.get.mockResolvedValue([
      {
        id: "cap-1",
        sentence: "Stop AI spend at $5,000 across the whole team per month",
      },
    ]);
    const res = new SpendControlsResource(http);

    const caps = await res.list();

    expect(http.get).toHaveBeenCalledWith("/control/caps");
    expect(caps[0].sentence).toContain("Stop AI spend");
  });

  it("spend(period) GETs /control/spend with only the period (dev filter omitted)", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      period: "week",
      org: { spentUsd: 42.5, eventCount: 3, unpricedEventCount: 0 },
      dev: null,
    });
    const res = new SpendControlsResource(http);

    const out = await res.spend("week");

    expect(http.get).toHaveBeenCalledWith("/control/spend", {
      period: "week",
      customerExternalId: undefined,
    });
    expect(out.org.spentUsd).toBe(42.5);
    expect(out.dev).toBeNull();
  });

  it("spend(period, dev) passes the customerExternalId through", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      period: "week",
      org: { spentUsd: null, eventCount: 0, unpricedEventCount: 0 },
      dev: {
        customerExternalId: "alice@acme.example",
        spentUsd: null,
        eventCount: 0,
        unpricedEventCount: 0,
      },
    });
    const res = new SpendControlsResource(http);

    const out = await res.spend("week", "alice@acme.example");

    expect(http.get).toHaveBeenCalledWith("/control/spend", {
      period: "week",
      customerExternalId: "alice@acme.example",
    });
    // honest null survives the round trip — no coercion to 0
    expect(out.org.spentUsd).toBeNull();
    expect(out.dev?.spentUsd).toBeNull();
  });

  it("spend() throws ValidationError with no period, before any HTTP call", async () => {
    const http = httpMock();
    const res = new SpendControlsResource(http);
    await expect(res.spend(undefined as any)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(http.get).not.toHaveBeenCalled();
  });

  it("coverage() GETs /control/coverage", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      armed: 3,
      total: 5,
      asOf: "2026-07-22T12:00:00.000Z",
    });
    const res = new SpendControlsResource(http);

    const cov = await res.coverage();

    expect(http.get).toHaveBeenCalledWith("/control/coverage");
    expect(cov.armed).toBe(3);
    expect(cov.total).toBe(5);
  });
});

describe("SpendControlsResource — breakdown", () => {
  const BREAKDOWN = {
    dimension: "branch",
    period: "week",
    window: {
      start: "2026-07-20T00:00:00.000Z",
      end: "2026-07-26T23:59:59.999Z",
    },
    asOf: "2026-07-23T12:00:00.000Z",
    totals: { spentUsd: 12.5, eventCount: 4, unpricedEventCount: 2 },
    rows: [
      {
        key: "acme/platform#feature/caps",
        spentUsd: 12.5,
        eventCount: 2,
        unpricedEventCount: 0,
      },
      {
        key: "acme/platform#main",
        spentUsd: null,
        eventCount: 1,
        unpricedEventCount: 1,
      },
    ],
    noMetadata: { spentUsd: null, eventCount: 1, unpricedEventCount: 1 },
    coveragePercent: 75,
  };

  it("breakdown() GETs /control/spend/breakdown with the period and dimension", async () => {
    const http = httpMock();
    http.get.mockResolvedValue(BREAKDOWN);
    const res = new SpendControlsResource(http);

    const out = await res.breakdown("week", "branch");

    expect(http.get).toHaveBeenCalledWith("/control/spend/breakdown", {
      period: "week",
      dimension: "branch",
    });
    // honest nulls survive the round trip — no reshaping, no coercion to 0
    expect(out).toEqual(BREAKDOWN);
  });

  it("breakdown() passes an all-null empty window through unchanged", async () => {
    const http = httpMock();
    http.get.mockResolvedValue({
      dimension: "repo",
      period: "month",
      totals: { spentUsd: null, eventCount: 0, unpricedEventCount: 0 },
      rows: [],
      noMetadata: { spentUsd: null, eventCount: 0, unpricedEventCount: 0 },
      coveragePercent: null,
    });
    const res = new SpendControlsResource(http);

    const out = await res.breakdown("month", "repo");

    expect(out.totals.spentUsd).toBeNull();
    expect(out.coveragePercent).toBeNull();
    expect(out.rows).toEqual([]);
  });

  it("breakdown() throws ValidationError with no period, before any HTTP call", async () => {
    const http = httpMock();
    const res = new SpendControlsResource(http);
    await expect(
      res.breakdown(undefined as any, "repo"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("breakdown() throws ValidationError with no dimension, before any HTTP call", async () => {
    const http = httpMock();
    const res = new SpendControlsResource(http);
    await expect(
      res.breakdown("week", undefined as any),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe("SpendControlsResource — writes", () => {
  it("create() POSTs /control/caps with the params and returns the sentence", async () => {
    const http = httpMock();
    http.post.mockResolvedValue({
      id: "cap-9",
      amountUsd: 200,
      sentence: "Stop Claude spend at $200 for alice@acme.example per week",
    });
    const res = new SpendControlsResource(http);

    const cap = await res.create({
      scope: "dev",
      scopeValue: "alice@acme.example",
      providerScope: "anthropic",
      amountUsd: 200,
      period: "week",
      mode: "enforce",
    });

    expect(http.post).toHaveBeenCalledWith("/control/caps", {
      scope: "dev",
      scopeValue: "alice@acme.example",
      providerScope: "anthropic",
      amountUsd: 200,
      period: "week",
      mode: "enforce",
    });
    expect(cap.sentence).toBe(
      "Stop Claude spend at $200 for alice@acme.example per week",
    );
  });

  it("update() PATCHes /control/caps/{id} (id url-encoded)", async () => {
    const http = httpMock();
    http.patch.mockResolvedValue({
      id: "cap 9",
      amountUsd: 350,
      sentence: "…",
    });
    const res = new SpendControlsResource(http);

    await res.update("cap 9", { amountUsd: 350 });

    expect(http.patch).toHaveBeenCalledWith("/control/caps/cap%209", {
      amountUsd: 350,
    });
  });

  it("update() throws ValidationError with an empty id", async () => {
    const http = httpMock();
    const res = new SpendControlsResource(http);
    await expect(res.update("", { amountUsd: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(http.patch).not.toHaveBeenCalled();
  });

  it("delete() DELETEs /control/caps/{id} and returns the removed sentence", async () => {
    const http = httpMock();
    http.delete.mockResolvedValue({
      deleted: true,
      sentence: "Stop Claude spend at $200 for alice@acme.example per week",
    });
    const res = new SpendControlsResource(http);

    const out = await res.delete("cap-9");

    expect(http.delete).toHaveBeenCalledWith("/control/caps/cap-9");
    expect(out.deleted).toBe(true);
    expect(out.sentence).toContain("Stop Claude spend");
  });

  it("surfaces the server's plain-English 403 message verbatim (no rewrite)", async () => {
    const http = httpMock();
    const serverMsg =
      "Only an owner or finance user can change spend caps. You can see them here.";
    http.post.mockRejectedValue(new Error(serverMsg));
    const res = new SpendControlsResource(http);

    await expect(
      res.create({
        scope: "org",
        providerScope: "all",
        amountUsd: 5000,
        period: "month",
        mode: "track",
      }),
    ).rejects.toThrow(serverMsg);
  });
});
