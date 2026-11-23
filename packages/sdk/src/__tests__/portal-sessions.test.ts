/**
 * Portal Sessions SDK Tests
 *
 * Two layers:
 * 1. Unit tests — mock the HTTP client; prove the SDK resource calls the
 *    canonical /portal-sessions path, validates inputs, and asserts
 *    secret-key auth.
 * 2. Integration test — when MF_TEST_SECRET_KEY (or MF_API_SECRET_KEY) is
 *    set, hits localhost:4000 end-to-end: create → list → get → revoke.
 *    Mirrors the production REST surface exactly.
 *
 * Prereqs for the integration leg:
 *   - api-nest running on localhost:4000
 *   - At least one customer exists in the org (created on demand if not)
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { MarginFrontClient } from "../client";
import { PortalSessionsResource } from "../resources/portal-sessions";
import { ValidationError } from "../errors";

// =============================================================================
// Unit tests (mocked HTTP)
// =============================================================================

describe("PortalSessionsResource (unit)", () => {
  it("calls canonical /portal-sessions on create", async () => {
    const post = vi.fn().mockResolvedValue({
      id: "ml_123",
      object: "portal_session",
      url: "http://acme.lvh.me:3000/api/portal-auth/from-magic-link?token=mgl_abc",
      token: "mgl_abc",
      customerId: "cust_1",
      customerName: "Acme",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      features: ["invoices", "subscriptions", "usage", "profile"],
      createdAt: new Date().toISOString(),
    });
    const http = { post, get: vi.fn(), delete: vi.fn() } as any;
    const resource = new PortalSessionsResource(http, () => {});

    const result = await resource.create({ customerId: "cust_1" });

    expect(post).toHaveBeenCalledWith("/portal-sessions", {
      customerId: "cust_1",
    });
    expect(result.token.startsWith("mgl_")).toBe(true);
    expect(result.url).toContain("/api/portal-auth/from-magic-link");
  });

  it("rejects create with neither customerId nor customerExternalId", async () => {
    const http = { post: vi.fn(), get: vi.fn(), delete: vi.fn() } as any;
    const resource = new PortalSessionsResource(http, () => {});

    await expect(resource.create({} as any)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("calls canonical /portal-sessions on get", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "ml_123",
      object: "portal_session",
      url: "http://acme.lvh.me:3000/api/portal-auth/from-magic-link?token=mgl_abc",
      token: "mgl_abc",
      customerId: "cust_1",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      features: ["invoices", "subscriptions", "usage", "profile"],
      createdAt: new Date().toISOString(),
    });
    const http = { post: vi.fn(), get, delete: vi.fn() } as any;
    const resource = new PortalSessionsResource(http, () => {});

    await resource.get("ml_123");

    expect(get).toHaveBeenCalledWith("/portal-sessions/ml_123");
  });

  it("rejects get with empty session ID", async () => {
    const http = { post: vi.fn(), get: vi.fn(), delete: vi.fn() } as any;
    const resource = new PortalSessionsResource(http, () => {});

    await expect(resource.get("")).rejects.toBeInstanceOf(ValidationError);
  });

  it("calls canonical /portal-sessions on list", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const http = { post: vi.fn(), get, delete: vi.fn() } as any;
    const resource = new PortalSessionsResource(http, () => {});

    await resource.list({ customerId: "cust_1", limit: 10 });

    expect(get).toHaveBeenCalledWith("/portal-sessions", {
      customerId: "cust_1",
      limit: 10,
      includeExpired: undefined,
    });
  });

  it("calls canonical /portal-sessions on revoke", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const http = { post: vi.fn(), get: vi.fn(), delete: del } as any;
    const resource = new PortalSessionsResource(http, () => {});

    await resource.revoke("ml_123");

    expect(del).toHaveBeenCalledWith("/portal-sessions/ml_123");
  });
});

// =============================================================================
// Integration tests (live API on localhost:4000)
// =============================================================================

const API_KEY = process.env.MF_TEST_SECRET_KEY || process.env.MF_API_SECRET_KEY;
const BASE_URL =
  process.env.MF_TEST_BASE_URL ||
  process.env.MARGINFRONT_API_URL ||
  "http://localhost:4000/v1";

const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("Portal Sessions Integration (live API)", () => {
  let client: MarginFrontClient;
  let customerId: string;

  beforeAll(async () => {
    client = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      fireAndForget: false,
      timeout: 10000,
      retries: 0,
    });

    // Find or create a test customer for this run.
    const list = await client.customers.list({ limit: 1 });
    const rows = Array.isArray(list)
      ? list
      : ((list as { data: { id: string }[] }).data ?? []);
    if (rows.length > 0) {
      customerId = rows[0].id;
    } else {
      const created = await client.customers.create({
        name: `Portal Test ${Date.now()}`,
        email: `portal-test-${Date.now()}@example.com`,
      });
      customerId = created.id;
    }
  });

  it("creates a single-use portal session with mgl_ prefix", async () => {
    const session = await client.portalSessions.create({ customerId });

    expect(session.id).toBeTruthy();
    expect(session.object).toBe("portal_session");
    expect(session.token.startsWith("mgl_")).toBe(true);
    expect(session.url).toContain("/api/portal-auth/from-magic-link");
    expect(session.features).toEqual(
      expect.arrayContaining(["invoices", "subscriptions", "usage", "profile"]),
    );
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("lists portal sessions for the customer (no token in response)", async () => {
    const created = await client.portalSessions.create({ customerId });
    const sessions = await client.portalSessions.list({ customerId });

    expect(Array.isArray(sessions)).toBe(true);
    const found = (sessions as any[]).find((s) => s.id === created.id);
    expect(found).toBeDefined();
    // Token MUST NOT be exposed in list responses (security control).
    expect(found.token).toBeUndefined();
    expect(found.isExpired).toBe(false);
    expect(found.isUsed).toBe(false);
  });

  it("creates → get → revoke → confirm gone", async () => {
    const created = await client.portalSessions.create({ customerId });

    const fetched = await client.portalSessions.get(created.id);
    expect(fetched.id).toBe(created.id);

    await client.portalSessions.revoke(created.id);

    await expect(client.portalSessions.get(created.id)).rejects.toThrow();
  });

  it("rejects creation when no customer identifier is provided", async () => {
    await expect(client.portalSessions.create({} as any)).rejects.toThrow();
  });
});
