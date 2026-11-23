/**
 * Raw HTTP API contract spec.
 *
 * These tests fire raw `fetch()` HTTP calls at the running api-nest dev
 * server (localhost:4000). NO SDK in between. NO MCP. NO test framework
 * abstraction over the wire format. Just HTTP, the way Python's
 * `requests.post()`, Ruby's `Net::HTTP`, Go's `http.Client`, or any
 * non-Node HTTP client would hit it.
 *
 * The point: prove the API contract works for ANY HTTP client, not just
 * the ones we ship. SDK + MCP integration tests cover their own happy
 * paths but mask raw-HTTP edge cases (header handling, encoding, request
 * body shape variants, exact response shape).
 *
 * Coverage groups:
 *   1. Validation contract: what the API rejects with 400 + English
 *      messages. Mirrors the SDK validator + the DTO union rule.
 *   2. Auth contract: missing key, invalid key, publishable key on a
 *      write endpoint.
 *   3. Multi-service happy paths: the union shapes fired as raw HTTP,
 *      asserting response shape.
 *   4. Response-shape contract: single vs multi distinct keys in the
 *      success body, multi-service failure includes servicesStatus.
 *   5. Created flags: a fresh-entity ingest reports which customer,
 *      agent and signal it created.
 *   6. GET endpoint smoke: /events and /analytics/cost work and return
 *      the documented shape.
 *
 * PREREQUISITES:
 *   - api-nest running on http://localhost:4000 against the test database
 *   - an org in the test database to send events to
 *   - MF_API_SECRET_KEY env var set to a valid mf_sk_* key for the org
 *
 * The suite skips cleanly when MF_API_SECRET_KEY isn't set, so CI
 * without secrets won't break and local runs without setup won't fail.
 *
 * RUN:
 *   MF_API_SECRET_KEY=<your mf_sk_ key> npx jest src/modules/sdk/raw-http-contract.spec.ts
 *
 * NEVER prints the API key. Uses process.env access only.
 */

const API_KEY = process.env.MF_TEST_SECRET_KEY || process.env.MF_API_SECRET_KEY;
const PUBLISHABLE_KEY = process.env.MF_TEST_PUBLISHABLE_KEY;
const BASE_URL =
  process.env.MF_TEST_BASE_URL || process.env.MARGINFRONT_API_URL || 'http://localhost:4000/v1';

const SANDBOX_CUSTOMER = 'sandbox-customer-001';
const SANDBOX_AGENT = 'sourcing-bot';
const SANDBOX_SIGNAL = 'sourcing-report';

// Skip the entire suite when no key is configured.
const describeIfKey = API_KEY ? describe : describe.skip;

interface PostOpts {
  apiKey?: string;
  contentType?: string;
  rawBody?: string;
}

async function postUsage(body: unknown, opts: PostOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': opts.contentType ?? 'application/json',
  };
  const key = opts.apiKey ?? API_KEY;
  if (key) headers['X-API-Key'] = key;

  return fetch(`${BASE_URL}/usage/record`, {
    method: 'POST',
    headers,
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

async function getJson(path: string, apiKey?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const key = apiKey ?? API_KEY;
  if (key) headers['X-API-Key'] = key;
  return fetch(`${BASE_URL}${path}`, { method: 'GET', headers });
}

const validSingleService = {
  customerExternalId: SANDBOX_CUSTOMER,
  agentCode: SANDBOX_AGENT,
  signalName: SANDBOX_SIGNAL,
  model: 'claude-sonnet-4-6',
  modelProvider: 'anthropic',
  inputTokens: 100,
  outputTokens: 50,
};

const validMultiService = {
  customerExternalId: SANDBOX_CUSTOMER,
  agentCode: SANDBOX_AGENT,
  signalName: SANDBOX_SIGNAL,
  quantity: 1,
  services: [
    {
      model: 'claude-sonnet-4-6',
      modelProvider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      quantity: 1,
    },
    {
      model: 'gpt-4o',
      modelProvider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      quantity: 1,
    },
  ],
};

describeIfKey('Raw HTTP API contract (live API, no SDK)', () => {
  // ===================================================================
  // GROUP 1: Validation contract (what the API rejects, 400 status)
  // ===================================================================
  describe('Group 1 — Validation contract', () => {
    it('1.1 rejects record missing customerExternalId', async () => {
      const { customerExternalId: _, ...rest } = validSingleService;
      const res = await postUsage({ records: [rest] });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body).toLowerCase()).toContain('customerexternalid');
    });

    it('1.2 rejects record missing agentCode', async () => {
      const { agentCode: _, ...rest } = validSingleService;
      const res = await postUsage({ records: [rest] });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body).toLowerCase()).toContain('agentcode');
    });

    it('1.3 rejects record missing signalName', async () => {
      const { signalName: _, ...rest } = validSingleService;
      const res = await postUsage({ records: [rest] });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body).toLowerCase()).toContain('signalname');
    });

    it('1.4 rejects single-service record missing model AND no services[]', async () => {
      const { model: _, ...rest } = validSingleService;
      const res = await postUsage({ records: [rest] });
      expect(res.status).toBe(400);
    });

    it('1.5 rejects single-service record missing modelProvider AND no services[]', async () => {
      const { modelProvider: _, ...rest } = validSingleService;
      const res = await postUsage({ records: [rest] });
      expect(res.status).toBe(400);
    });

    it('1.6 rejects multi-service with empty services[]', async () => {
      const res = await postUsage({
        records: [
          {
            customerExternalId: SANDBOX_CUSTOMER,
            agentCode: SANDBOX_AGENT,
            signalName: SANDBOX_SIGNAL,
            services: [],
          },
        ],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body)).toMatch(/services\[\] is empty|empty/i);
    });

    it('1.7 rejects multi-service when services is not an array', async () => {
      const res = await postUsage({
        records: [
          {
            customerExternalId: SANDBOX_CUSTOMER,
            agentCode: SANDBOX_AGENT,
            signalName: SANDBOX_SIGNAL,
            services: 'not an array',
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it('1.8 rejects mixed shape (top-level model AND services[])', async () => {
      const res = await postUsage({
        records: [
          {
            ...validSingleService,
            services: [
              {
                model: 'gpt-4o',
                modelProvider: 'openai',
                inputTokens: 1,
                outputTokens: 1,
              },
            ],
          },
        ],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body)).toMatch(/cannot mix shapes/i);
    });

    it('1.9 rejects record with neither shape (no model, no services)', async () => {
      const res = await postUsage({
        records: [
          {
            customerExternalId: SANDBOX_CUSTOMER,
            agentCode: SANDBOX_AGENT,
            signalName: SANDBOX_SIGNAL,
            inputTokens: 100,
            outputTokens: 50,
          },
        ],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body)).toMatch(/provide either model \+ modelprovider|either/i);
    });

    it('1.10 rejects negative inputTokens', async () => {
      const res = await postUsage({
        records: [{ ...validSingleService, inputTokens: -1 }],
      });
      expect(res.status).toBe(400);
    });

    it('1.11 rejects non-integer inputTokens', async () => {
      const res = await postUsage({
        records: [{ ...validSingleService, inputTokens: 1.5 }],
      });
      expect(res.status).toBe(400);
    });

    it('1.12 rejects invalid usageDate string', async () => {
      const res = await postUsage({
        records: [{ ...validSingleService, usageDate: 'not-a-date' }],
      });
      expect(res.status).toBe(400);
    });

    it('1.13 rejects empty records array', async () => {
      const res = await postUsage({ records: [] });
      expect(res.status).toBe(400);
    });

    it('1.14 rejects records as object instead of array', async () => {
      const res = await postUsage({ records: validSingleService });
      expect(res.status).toBe(400);
    });

    it('1.15 rejects batch over 100 records', async () => {
      const records = Array.from({ length: 101 }, () => validSingleService);
      const res = await postUsage({ records });
      expect(res.status).toBe(400);
    });

    it('1.16 rejects malformed JSON body', async () => {
      const res = await postUsage(undefined, { rawBody: '{ "records": [{,]' });
      expect(res.status).toBe(400);
    });

    it('1.17 rejects multi-service entry missing model', async () => {
      const res = await postUsage({
        records: [
          {
            customerExternalId: SANDBOX_CUSTOMER,
            agentCode: SANDBOX_AGENT,
            signalName: SANDBOX_SIGNAL,
            quantity: 1,
            services: [{ modelProvider: 'anthropic', inputTokens: 100 }],
          },
        ],
      });
      expect(res.status).toBe(400);
    });
  });

  // ===================================================================
  // GROUP 2: Auth contract
  // ===================================================================
  describe('Group 2 — Auth contract', () => {
    it('2.1 rejects request with missing X-API-Key', async () => {
      const res = await postUsage({ records: [validSingleService] }, { apiKey: '' });
      // Depending on guard order, could be 401 or 403
      expect([401, 403]).toContain(res.status);
    });

    it('2.2 rejects request with invalid X-API-Key', async () => {
      const res = await postUsage(
        { records: [validSingleService] },
        { apiKey: 'mf_sk_invalid_key_does_not_exist' },
      );
      expect([401, 403]).toContain(res.status);
    });

    it('2.3 publishable key (mf_pk_*) cannot POST /usage/record', async () => {
      if (!PUBLISHABLE_KEY) {
        // Skip if no publishable key configured
        return;
      }
      const res = await postUsage({ records: [validSingleService] }, { apiKey: PUBLISHABLE_KEY });
      expect([401, 403]).toContain(res.status);
    });
  });

  // ===================================================================
  // GROUP 3: Multi-service happy paths (raw HTTP firing of the union shapes)
  // ===================================================================
  describe('Group 3 — Multi-service happy paths', () => {
    it('3.1 single-service event with two known LLMs lands successful', async () => {
      const res = await postUsage({ records: [validSingleService] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.processed).toBe(1);
      expect(body.successful).toBeGreaterThanOrEqual(1);
      // Single-service success should have model + modelProvider at top level
      const success = body.results.success[0];
      expect(success.model).toBe('claude-sonnet-4-6');
      expect(success.modelProvider).toBe('anthropic');
      expect(success.eventId).toBeTruthy();
    });

    it('3.2 multi-service event (two known LLMs) lands successful with services[] echo', async () => {
      const res = await postUsage({ records: [validMultiService] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.processed).toBe(1);
      expect(body.successful).toBeGreaterThanOrEqual(1);
      const success = body.results.success[0];
      expect(success.services).toBeDefined();
      expect(Array.isArray(success.services)).toBe(true);
      expect(success.services.length).toBe(2);
      expect(success.totalCostUsd).toBeTruthy();
      expect(success.eventId).toBeTruthy();
      // Cost rule: parent totalCostUsd = SUM(services[].usageCost)
      const sum = success.services.reduce(
        (acc: number, s: any) => acc + parseFloat(s.usageCost),
        0,
      );
      expect(parseFloat(success.totalCostUsd)).toBeCloseTo(sum, 6);
    });

    it('3.3 multi-service with one unmapped service lands NEEDS_COST_BACKFILL', async () => {
      const res = await postUsage({
        records: [
          {
            customerExternalId: SANDBOX_CUSTOMER,
            agentCode: SANDBOX_AGENT,
            signalName: SANDBOX_SIGNAL,
            quantity: 1,
            services: [
              {
                model: 'claude-sonnet-4-6',
                modelProvider: 'anthropic',
                inputTokens: 100,
                outputTokens: 50,
                quantity: 1,
              },
              {
                model: `unmapped-service-${Date.now()}`,
                modelProvider: 'custom',
                quantity: 1,
              },
            ],
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.processed).toBe(1);
      const failed = body.results.failed[0];
      expect(failed.code).toBe('NEEDS_COST_BACKFILL');
      expect(failed.stored).toBe(true);
      expect(failed.eventId).toBeTruthy();
      // Multi-service failed includes per-service status
      expect(failed.servicesStatus).toBeDefined();
      expect(Array.isArray(failed.servicesStatus)).toBe(true);
      expect(failed.servicesStatus.length).toBe(2);
    });

    it('3.4 multi-service with one missing volume lands MISSING_VOLUME_DATA', async () => {
      const res = await postUsage({
        records: [
          {
            customerExternalId: SANDBOX_CUSTOMER,
            agentCode: SANDBOX_AGENT,
            signalName: SANDBOX_SIGNAL,
            quantity: 1,
            services: [
              {
                model: 'claude-sonnet-4-6',
                modelProvider: 'anthropic',
                inputTokens: 100,
                outputTokens: 50,
                quantity: 1,
              },
              {
                // GPT-4o without inputTokens/outputTokens → missing volume
                model: 'gpt-4o',
                modelProvider: 'openai',
              },
            ],
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const failed = body.results.failed[0];
      expect(failed.code).toBe('MISSING_VOLUME_DATA');
      expect(failed.stored).toBe(true);
    });

    it('3.5 batch mixing single + multi-service entries works', async () => {
      const res = await postUsage({
        records: [validSingleService, validMultiService],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.processed).toBe(2);
      const total = body.successful + body.failed;
      expect(total).toBe(2);
    });
  });

  // ===================================================================
  // GROUP 4: Response shape contract
  // ===================================================================
  describe('Group 4 — Response shape contract', () => {
    it('4.1 single-service success has top-level model/modelProvider/tokens, NO services[]', async () => {
      const res = await postUsage({ records: [validSingleService] });
      const body = await res.json();
      const success = body.results.success[0];
      expect(success.model).toBeTruthy();
      expect(success.modelProvider).toBeTruthy();
      expect(success.inputTokens).toBeDefined();
      expect(success.outputTokens).toBeDefined();
      expect(success.services).toBeUndefined();
    });

    it('4.2 multi-service success has services[] with per-service usageCost + eventStatus', async () => {
      const res = await postUsage({ records: [validMultiService] });
      const body = await res.json();
      const success = body.results.success[0];
      expect(Array.isArray(success.services)).toBe(true);
      for (const svc of success.services) {
        expect(svc.model).toBeTruthy();
        expect(svc.modelProvider).toBeTruthy();
        expect(svc.usageCost).toBeTruthy();
        expect(svc.eventStatus).toBeTruthy();
      }
    });

    it('4.3 multi-service success does NOT have legacy top-level model/modelProvider', async () => {
      const res = await postUsage({ records: [validMultiService] });
      const body = await res.json();
      const success = body.results.success[0];
      expect(success.model).toBeUndefined();
      expect(success.modelProvider).toBeUndefined();
      expect(success.inputTokens).toBeUndefined();
      expect(success.outputTokens).toBeUndefined();
    });

    it('4.4 multi-service failed has servicesStatus[] with per-service status', async () => {
      const res = await postUsage({
        records: [
          {
            customerExternalId: SANDBOX_CUSTOMER,
            agentCode: SANDBOX_AGENT,
            signalName: SANDBOX_SIGNAL,
            quantity: 1,
            services: [
              {
                model: `another-unmapped-${Date.now()}`,
                modelProvider: 'custom',
                quantity: 1,
              },
            ],
          },
        ],
      });
      const body = await res.json();
      const failed = body.results.failed[0];
      expect(failed.servicesStatus).toBeDefined();
      expect(failed.servicesStatus[0].model).toBeTruthy();
      expect(failed.servicesStatus[0].modelProvider).toBeTruthy();
      expect(failed.servicesStatus[0].eventStatus).toBeTruthy();
    });
  });

  // ===================================================================
  // GROUP 5: created-flags contract
  // ===================================================================
  describe('Group 5: created flags', () => {
    it('6.1 fresh-entity ingest reports created.customer/agent/signal booleans', async () => {
      const stamp = Date.now();
      const res = await postUsage({
        records: [
          {
            ...validSingleService,
            customerExternalId: `created-flags-cust-${stamp}`,
            agentCode: `created-flags-agent-${stamp}`,
            signalName: `created-flags-signal-${stamp}`,
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const success = body.results.success[0];
      expect(success.created).toEqual({ customer: true, agent: true, signal: true });
    });

    it('6.2 pre-existing entities report created: false across the board', async () => {
      const res = await postUsage({ records: [validSingleService] });
      expect(res.status).toBe(200);
      const body = await res.json();
      const success = body.results.success[0];
      expect(success.created).toEqual({ customer: false, agent: false, signal: false });
    });

    it('6.3 idempotent replay row has NO created key (undefined, not false)', async () => {
      const idempotencyKey = `created-flags-replay-${Date.now()}`;
      const record = { ...validSingleService, idempotencyKey };

      const first = await postUsage({ records: [record] });
      expect(first.status).toBe(200);
      const firstRow = (await first.json()).results.success[0];
      expect(firstRow.created).toBeDefined();

      const replay = await postUsage({ records: [record] });
      expect(replay.status).toBe(200);
      const replayRow = (await replay.json()).results.success[0];
      expect(replayRow.eventId).toBe(firstRow.eventId);
      expect('created' in replayRow).toBe(false);
    });
  });

  // ===================================================================
  // GROUP 6: GET endpoint smoke (read contract)
  // ===================================================================
  describe('Group 6: GET endpoint smoke', () => {
    it('5.1 GET /v1/events returns 200 with results array', async () => {
      const res = await getJson('/events?limit=5');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.results)).toBe(true);
    });

    it('5.2 GET /v1/analytics/cost returns 200 with cost + byModel', async () => {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const res = await getJson(
        `/analytics/cost?startDate=${dayAgo.toISOString()}&endDate=${now.toISOString()}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.cost).toBe('number');
      expect(Array.isArray(body.byModel)).toBe(true);
    });

    it('5.3 GET /v1/analytics/cost includes signal_event_services contributions in byModel', async () => {
      // Fire a multi-service event first to ensure there's something to roll up
      await postUsage({ records: [validMultiService] });
      // Brief settle
      await new Promise((r) => setTimeout(r, 300));
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const res = await getJson(
        `/analytics/cost?startDate=${dayAgo.toISOString()}&endDate=${now.toISOString()}`,
      );
      const body = await res.json();
      const hasClaude = body.byModel.some((b: any) => /claude|sonnet/i.test(b.model ?? ''));
      const hasGpt = body.byModel.some((b: any) => /gpt-4o/i.test(b.model ?? ''));
      expect(hasClaude || hasGpt).toBe(true);
    });
  });
});
