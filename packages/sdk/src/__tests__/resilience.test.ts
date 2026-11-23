/**
 * SDK Resilience Tests
 *
 * These tests prove the MarginFront SDK doesn't break customer applications
 * when things go wrong. They use unreachable ports and mock HTTP servers —
 * nothing hits a real server.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { MarginFrontClient } from "../client";
import {
  NetworkError,
  TimeoutError,
  AuthenticationError,
  AuthorizationError,
  InternalError,
} from "../errors";
import type { UsageRecord } from "../types";

const validRecord: UsageRecord = {
  customerExternalId: "test-cust",
  agentCode: "test-agent",
  signalName: "test-signal",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 100,
  outputTokens: 50,
};

// Shared success response shape the API returns for /usage/record
const successResponse = {
  processed: 1,
  successful: 1,
  failed: 0,
  results: {
    success: [
      {
        eventId: "evt_test",
        rawEventId: "raw_test",
        timestamp: new Date().toISOString(),
        customerExternalId: validRecord.customerExternalId,
        agentCode: validRecord.agentCode,
        signalName: validRecord.signalName,
        quantity: 1,
        totalCostUsd: "0.001",
      },
    ],
    failed: [],
  },
};

// Helper to start an HTTP server on a random port and return { server, port }
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

describe("SDK Resilience", () => {
  // -------------------------------------------------------------------------
  // fireAndForget: true swallows network errors
  // -------------------------------------------------------------------------
  describe("fireAndForget=true swallows network errors", () => {
    it("does not throw when the endpoint is unreachable", async () => {
      const client = new MarginFrontClient({
        apiKey: "mf_sk_test_fake",
        baseUrl: "http://localhost:65432/v1", // unreachable port
        fireAndForget: true,
        retries: 0,
        timeout: 500,
      });

      const result = await client.usage.record({ ...validRecord });

      // No throw — and the response says the event was NOT delivered
      expect(result.processed).toBe(1);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.delivered).toBe(false);
      expect(result.buffered).toBe(1);
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // fireAndForget: false DOES throw network error
  // -------------------------------------------------------------------------
  describe("fireAndForget=false throws network error", () => {
    it("rejects with NetworkError when the endpoint is unreachable", async () => {
      const client = new MarginFrontClient({
        apiKey: "mf_sk_test_fake",
        baseUrl: "http://localhost:65432/v1", // unreachable port
        fireAndForget: false,
        retries: 0,
        timeout: 500,
      });

      await expect(client.usage.record({ ...validRecord })).rejects.toThrow(
        NetworkError,
      );
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // Timeout fires when server is slow
  // -------------------------------------------------------------------------
  describe("timeout fires when server is slow", () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      ({ server, port } = await startServer((_req, res) => {
        // Respond after 5 seconds — much longer than the client's timeout
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(successResponse));
        }, 5000);
      }));
    });

    afterEach(async () => {
      await stopServer(server);
    });

    it("rejects with TimeoutError before the server responds", async () => {
      const client = new MarginFrontClient({
        apiKey: "mf_sk_test_fake",
        baseUrl: `http://localhost:${port}/v1`,
        fireAndForget: false,
        retries: 0,
        timeout: 300,
      });

      const startTime = Date.now();
      await expect(client.usage.record({ ...validRecord })).rejects.toThrow(
        TimeoutError,
      );
      const elapsed = Date.now() - startTime;

      // Should fire well before the 5-second server response
      expect(elapsed).toBeLessThan(2000);
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // HTTP retry loop retries on 500 and eventually succeeds
  //
  // These retries come from the HTTP layer's retry loop (http.ts request()
  // method), NOT the RetryBuffer class. The retry loop is
  // `for (let retry = 0; retry <= this.retries; retry++)` — so retries=3 means
  // up to 4 total attempts (1 initial + 3 retries).
  // -------------------------------------------------------------------------
  describe("retries on 500 then succeeds", () => {
    let server: Server;
    let port: number;
    let callCount = 0;

    beforeEach(async () => {
      callCount = 0;
      ({ server, port } = await startServer((_req, res) => {
        callCount++;
        if (callCount < 3) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Internal Server Error" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(successResponse));
        }
      }));
    });

    afterEach(async () => {
      await stopServer(server);
    });

    it("retries on 500 and eventually succeeds on the 3rd attempt", async () => {
      const client = new MarginFrontClient({
        apiKey: "mf_sk_test_fake",
        baseUrl: `http://localhost:${port}/v1`,
        fireAndForget: false,
        retries: 3,
        timeout: 3000,
        retryDelay: 50, // Fast retries to keep the test snappy
      });

      const result = await client.usage.record({ ...validRecord });
      expect(result.successful).toBe(1);
      expect(result.failed).toBe(0);
      expect(callCount).toBe(3);
    }, 15000);
  });

  // -------------------------------------------------------------------------
  // HTTP retry loop gives up after max retries
  //
  // The HTTP retry loop runs `1 + retries` total attempts. With retries: 2,
  // that's 3 attempts. On the final failure, parseApiError() wraps the 500
  // as an InternalError (statusCode 500 -> InternalError). Since fireAndForget
  // is false, this error bubbles up.
  // -------------------------------------------------------------------------
  describe("gives up after max retries", () => {
    let server: Server;
    let port: number;
    let callCount = 0;

    beforeEach(async () => {
      callCount = 0;
      ({ server, port } = await startServer((_req, res) => {
        callCount++;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Internal Server Error" }));
      }));
    });

    afterEach(async () => {
      await stopServer(server);
    });

    it("throws InternalError after retries+1 total attempts when fireAndForget=false", async () => {
      const client = new MarginFrontClient({
        apiKey: "mf_sk_test_fake",
        baseUrl: `http://localhost:${port}/v1`,
        fireAndForget: false,
        retries: 2,
        timeout: 3000,
        retryDelay: 50,
      });

      await expect(client.usage.record({ ...validRecord })).rejects.toThrow(
        InternalError,
      );

      // retries: 2 = 3 total attempts (1 initial + 2 retries)
      expect(callCount).toBe(3);
    }, 15000);
  });

  // -------------------------------------------------------------------------
  // Invalid API key throws AuthenticationError
  // -------------------------------------------------------------------------
  describe("401 throws AuthenticationError", () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      ({ server, port } = await startServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Unauthorized",
            message: "Invalid API key",
            statusCode: 401,
          }),
        );
      }));
    });

    afterEach(async () => {
      await stopServer(server);
    });

    it("rejects with AuthenticationError on 401", async () => {
      const client = new MarginFrontClient({
        apiKey: "mf_sk_test_fake",
        baseUrl: `http://localhost:${port}/v1`,
        fireAndForget: false,
        retries: 0,
        timeout: 2000,
      });

      await expect(client.usage.record({ ...validRecord })).rejects.toThrow(
        AuthenticationError,
      );
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // Publishable key write throws AuthorizationError
  // -------------------------------------------------------------------------
  describe("403 throws AuthorizationError", () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
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
    });

    afterEach(async () => {
      await stopServer(server);
    });

    it("rejects with AuthorizationError on 403 (secret key required)", async () => {
      const client = new MarginFrontClient({
        apiKey: "mf_pk_test_publishable",
        baseUrl: `http://localhost:${port}/v1`,
        fireAndForget: false,
        retries: 0,
        timeout: 2000,
      });

      await expect(client.usage.record({ ...validRecord })).rejects.toThrow(
        AuthorizationError,
      );
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // Concurrent recordBatch calls don't interfere
  //
  // Each parallel recordBatch() call sends a POST with a distinct body. The
  // mock server echoes back a marker derived from the body so we can confirm
  // each promise resolves with its own response.
  // -------------------------------------------------------------------------
  describe("concurrent recordBatch calls don't interfere", () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      ({ server, port } = await startServer((_req, res, body) => {
        // Parse the request, pull the first record's signalName, and echo it
        // back in the response. This lets us detect cross-contamination.
        let signalName = "unknown";
        try {
          const parsed = JSON.parse(body);
          signalName = parsed.records?.[0]?.signalName ?? "unknown";
        } catch {
          // body parse failure — leave signalName as "unknown"
        }

        // Simulate some variable processing time so responses don't come back
        // in the same order requests were sent (tests cross-contamination).
        const delayMs =
          signalName === "signal-a" ? 80 : signalName === "signal-b" ? 30 : 50;

        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              processed: 1,
              successful: 1,
              failed: 0,
              results: {
                success: [
                  {
                    eventId: `evt_${signalName}`,
                    rawEventId: `raw_${signalName}`,
                    timestamp: new Date().toISOString(),
                    customerExternalId: "test-cust",
                    agentCode: "test-agent",
                    signalName,
                    quantity: 1,
                    totalCostUsd: "0.001",
                  },
                ],
                failed: [],
              },
            }),
          );
        }, delayMs);
      }));
    });

    afterEach(async () => {
      await stopServer(server);
    });

    it("three parallel recordBatch calls each resolve with their own response", async () => {
      const client = new MarginFrontClient({
        apiKey: "mf_sk_test_fake",
        baseUrl: `http://localhost:${port}/v1`,
        fireAndForget: false,
        retries: 0,
        timeout: 3000,
      });

      const [resA, resB, resC] = await Promise.all([
        client.usage.recordBatch([{ ...validRecord, signalName: "signal-a" }]),
        client.usage.recordBatch([{ ...validRecord, signalName: "signal-b" }]),
        client.usage.recordBatch([{ ...validRecord, signalName: "signal-c" }]),
      ]);

      // Each promise should resolve with its own distinct eventId marker
      expect(resA.results.success[0].eventId).toBe("evt_signal-a");
      expect(resB.results.success[0].eventId).toBe("evt_signal-b");
      expect(resC.results.success[0].eventId).toBe("evt_signal-c");

      // And each should have the matching signalName
      expect(resA.results.success[0].signalName).toBe("signal-a");
      expect(resB.results.success[0].signalName).toBe("signal-b");
      expect(resC.results.success[0].signalName).toBe("signal-c");
    }, 10000);
  });
});
