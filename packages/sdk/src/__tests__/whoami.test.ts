/**
 * SDK identity surface (client.whoami() / client.keyRole)
 * and the insufficient_key_role 403 envelope on AuthorizationError.
 *
 * Drives the REAL MarginFrontClient against a throwaway local HTTP server (same
 * pattern as resilience.test.ts) so this exercises the real HttpClient request
 * path, not a mocked resource. No production code under test is mocked.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { MarginFrontClient } from "../client";
import { AuthorizationError } from "../errors";
import type { UsageRecord } from "../types";

async function startServer(
  handler: (req: any, res: any, body: string) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const validRecord: UsageRecord = {
  customerExternalId: "test-cust",
  agentCode: "test-agent",
  signalName: "test-signal",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 100,
  outputTokens: 50,
};

// The exact body shape InsufficientKeyRoleException produces
// (apps/api-nest/src/common/exceptions/insufficient-key-role.exception.ts).
function insufficientKeyRoleBody(keyRole: string, requiredRoles: string[]) {
  return {
    statusCode: 403,
    code: "insufficient_key_role",
    required_roles: requiredRoles,
    key_role: keyRole,
    message:
      `This API key's role ('${keyRole}') is not permitted to perform this action. ` +
      `Allowed roles: ${requiredRoles.join(", ")}.`,
  };
}

describe("client.whoami() / client.keyRole (GET /me/key)", () => {
  let server: Server;
  let port: number;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  it("keyRole is null before whoami() has ever been called", () => {
    const client = new MarginFrontClient({
      apiKey: "mf_sk_test_fake",
      baseUrl: "http://localhost:1/v1",
    });
    expect(client.keyRole).toBeNull();
  });

  it.each([
    ["ingest", "secret"],
    ["member", "secret"],
    ["developer", "secret"],
    ["finance", "publishable"],
    ["admin", "secret"],
    ["owner", "secret"],
  ] as const)(
    "whoami() returns role=%s keyType=%s and caches it on client.keyRole",
    async (role, keyType) => {
      let requestedPath: string | undefined;
      ({ server, port } = await startServer((req, res) => {
        requestedPath = req.url;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ role, keyType }));
      }));

      const client = new MarginFrontClient({
        apiKey: "mf_sk_test_fake",
        baseUrl: `http://localhost:${port}/v1`,
        fireAndForget: false,
        retries: 0,
      });

      const result = await client.whoami();

      expect(result).toEqual({ role, keyType });
      expect(client.keyRole).toBe(role);
      expect(requestedPath).toBe("/v1/me/key");
    },
  );
});

describe("AuthorizationError carries {requiredRoles, keyRole} from insufficient_key_role", () => {
  let server: Server;
  let port: number;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  it("rejects with AuthorizationError exposing requiredRoles + keyRole", async () => {
    ({ server, port } = await startServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          insufficientKeyRoleBody("developer", ["finance", "admin", "owner"]),
        ),
      );
    }));

    const client = new MarginFrontClient({
      apiKey: "mf_sk_test_fake",
      baseUrl: `http://localhost:${port}/v1`,
      fireAndForget: false,
      retries: 0,
      timeout: 2000,
    });

    let caught: unknown;
    try {
      await client.customers.create({ name: "Should Fail" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthorizationError);
    const err = caught as AuthorizationError;
    expect(err.keyRole).toBe("developer");
    expect(err.requiredRoles).toEqual(["finance", "admin", "owner"]);
  });

  it("a plain (non-role) 403 leaves requiredRoles/keyRole undefined", async () => {
    ({ server, port } = await startServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Forbidden",
          message: "Secret key required for this operation",
          statusCode: 403,
        }),
      );
    }));

    const client = new MarginFrontClient({
      apiKey: "mf_pk_test_fake",
      baseUrl: `http://localhost:${port}/v1`,
      fireAndForget: false,
      retries: 0,
      timeout: 2000,
    });

    let caught: unknown;
    try {
      await client.usage.record({ ...validRecord });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthorizationError);
    const err = caught as AuthorizationError;
    expect(err.keyRole).toBeUndefined();
    expect(err.requiredRoles).toBeUndefined();
  });
});

describe("usage.record can never throw an insufficient_key_role 403 (fireAndForget default)", () => {
  let server: Server;
  let port: number;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  it("swallows a (hypothetical) insufficient_key_role 403 on /usage/record and reports it as undelivered", async () => {
    ({ server, port } = await startServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          insufficientKeyRoleBody("ingest", ["developer", "admin", "owner"]),
        ),
      );
    }));

    // fireAndForget defaults to true — never pass fireAndForget here, the point
    // of this test is the DEFAULT behavior every ingest-only SDK user gets.
    const client = new MarginFrontClient({
      apiKey: "mf_sk_test_fake",
      baseUrl: `http://localhost:${port}/v1`,
      retries: 0,
      timeout: 2000,
    });

    const result = await client.usage.record({ ...validRecord });

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(false);
  });
});
