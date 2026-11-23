/**
 * WHAT THIS FILE DOES:
 *   Unit tests for CustomerFailureAlertService.
 *   Pins:
 *     - per-bucket windowed counting (INCR + EXPIRE-on-first),
 *     - the threshold + cooldown-NX gate (exactly one Slack alert per bucket per
 *       cooldown),
 *     - IP-primary keying for UNTRUSTED failures (a varying-
 *       email flood from one IP cannot evade the counter),
 *     - the POST-AUTH classes (bad_data / forbidden / rate_limit): trusted
 *       org-keyed bucketing, no scanner gate, per-class threshold + copy,
 *     - the Sentry-free Slack POST,
 *     - the fail-open posture (no Redis URL / no webhook / Redis error / Slack
 *       non-2xx all SKIP the alert and NEVER throw — the response is untouched).
 *
 * MODELED ON: webhook-dedupe.service.spec.ts (jest.mock("ioredis") + stubbed
 *   ConfigService). The one divergence: no Sentry mock — this service is
 *   Sentry-free by design; it alerts via a Slack webhook (mocked global.fetch).
 */
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  CustomerFailureAlertService,
  type CustomerFailureContext,
} from './customer-failure-alert.service';
import type { ClaimedIdentity } from './lib/extract-claimed-identity';
import type { RevokedKeyNoticeService } from './revoked-key-notice.service';

// Hoisted mock: every `new Redis(...)` returns the same handle so the spec can
// stub incr/expire/set and assert call shape.
const mockRedis = {
  incr: jest.fn(),
  expire: jest.fn().mockResolvedValue(1),
  set: jest.fn(),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
};
jest.mock('ioredis', () => jest.fn().mockImplementation(() => mockRedis));

const REDIS_URL = 'redis://localhost:6379';
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/xxxx';

function buildConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function fullEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { REDIS_URL, AUTH_FAILURE_SLACK_WEBHOOK_URL: WEBHOOK, ...extra };
}

// The owner-notice dep every construction site shares. A bare
// jest.fn (cleared with everything else in beforeEach) so the throttle tests
// can pin exactly when the email decision fires.
const noticeNotify = jest.fn().mockResolvedValue(undefined);

function makeService(config: ConfigService): CustomerFailureAlertService {
  return new CustomerFailureAlertService(config, {
    notify: noticeNotify,
  } as unknown as RevokedKeyNoticeService);
}

// A pre-auth (401) ClaimedIdentity. ClaimedIdentity is a structural subset of
// CustomerFailureContext, so it passes straight through recordFailure('auth_401', …).
function identity(overrides: Partial<ClaimedIdentity> = {}): ClaimedIdentity {
  return {
    callerIp: '1.2.3.4',
    claimedEmail: 'cust@example.com',
    path: '/v1/sdk/usage',
    source: 'sdk',
    keyFingerprint: 'mf_sk_abcdef012345',
    recognizedCredential: true,
    ...overrides,
  };
}

// An anonymous, scanner-shaped rejection: no claimed body identity, no
// recognized MarginFront credential, and the detectSource fallback 'api'. This
// is the traffic the alert gate must DROP so the alerts channel isn't buried.
function anonymousNoise(overrides: Partial<ClaimedIdentity> = {}): ClaimedIdentity {
  return identity({
    claimedEmail: undefined,
    source: 'api',
    keyFingerprint: undefined,
    recognizedCredential: false,
    ...overrides,
  });
}

// A POST-auth (trusted) context: req.user was set, so we have a validated org.
// Buckets on org:<id>, skips the scanner gate, shows the trusted email.
function trustedCtx(overrides: Partial<CustomerFailureContext> = {}): CustomerFailureContext {
  return {
    organizationId: 'org_123',
    organizationName: 'Acme Co',
    email: 'ops@acme.example',
    callerIp: '5.6.7.8',
    path: '/v1/sdk/usage',
    method: 'POST',
    source: 'sdk',
    ...overrides,
  };
}

describe('CustomerFailureAlertService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    // The service uses global fetch (no SDK) so the alert path works even when
    // everything else is down. Stub it.
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  describe('windowed counting (auth_401)', () => {
    it('INCRs the per-IP counter and EXPIREs it on the FIRST failure only', async () => {
      mockRedis.incr.mockResolvedValueOnce(1);
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity());

      expect(mockRedis.incr).toHaveBeenCalledWith('auth-failure:count:1.2.3.4');
      // First failure anchors the 15-min sliding window.
      expect(mockRedis.expire).toHaveBeenCalledWith('auth-failure:count:1.2.3.4', 900);
    });

    it('does NOT reset the window on subsequent failures (EXPIRE only at count 1)', async () => {
      mockRedis.incr.mockResolvedValueOnce(3);
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity());

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('stays silent below the threshold (no cooldown SET, no Slack POST)', async () => {
      mockRedis.incr.mockResolvedValueOnce(4); // default threshold is 5
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity());

      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('threshold + cooldown gate (auth_401)', () => {
    it('fires ONE Slack alert when the threshold is crossed and cooldown NX is open', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK'); // cooldown acquired
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity());

      // Cooldown gate is an NX SET with the configured 1h TTL.
      expect(mockRedis.set).toHaveBeenCalledWith(
        'auth-failure:cooldown:1.2.3.4',
        '1',
        'EX',
        3600,
        'NX',
      );
      // Exactly one Slack POST, to the configured webhook, carrying the IP.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(WEBHOOK);
      expect(opts.method).toBe('POST');
      const sent = JSON.parse(opts.body);
      expect(sent.text).toContain('1.2.3.4');
      expect(sent.text).toContain('claimed/untrusted');
      // Headline pinned verbatim.
      expect(sent.text).toContain('SDK auth failures detected');
    });

    it('does NOT re-alert when the cooldown key already exists (NX returns null)', async () => {
      mockRedis.incr.mockResolvedValueOnce(9); // well over threshold
      mockRedis.set.mockResolvedValueOnce(null); // cooldown still held
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity());

      expect(mockRedis.set).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('honors a custom threshold + window + cooldown from config', async () => {
      mockRedis.incr.mockResolvedValueOnce(2);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(
        buildConfig(
          fullEnv({
            AUTH_FAILURE_ALERT_THRESHOLD: '2',
            AUTH_FAILURE_ALERT_WINDOW_SECONDS: '60',
            AUTH_FAILURE_ALERT_COOLDOWN_SECONDS: '120',
          }),
        ),
      );

      await svc.recordFailure('auth_401', identity());

      // Threshold lowered to 2, so count 2 fires; cooldown TTL is the custom 120.
      expect(mockRedis.set).toHaveBeenCalledWith(
        'auth-failure:cooldown:1.2.3.4',
        '1',
        'EX',
        120,
        'NX',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('scanner-noise gate — UNTRUSTED only', () => {
    it('DROPS anonymous scanner noise: no count, no alert even past threshold', async () => {
      // If the gate weren't there this would INCR and (at count 5) page Slack.
      mockRedis.incr.mockResolvedValue(5);
      mockRedis.set.mockResolvedValue('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', anonymousNoise());

      // Gated out BEFORE touching Redis — no key cardinality, no cooldown burn.
      expect(mockRedis.incr).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ALERTS when only a recognized credential is present (raw-API customer, broken real key)', async () => {
      // source 'api' + NO claimed body id, but the presented key has a known
      // mf_sk_ prefix → a real customer whose key broke. Must still page.
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure(
        'auth_401',
        anonymousNoise({ recognizedCredential: true, keyFingerprint: 'mf_sk_deadbeef0001' }),
      );

      expect(mockRedis.incr).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('ALERTS when the source is one of our packages (sdk) even with no claimed id / no recognized key', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure(
        'auth_401',
        anonymousNoise({ source: 'sdk' }), // claimedEmail undefined, recognizedCredential false
      );

      expect(mockRedis.incr).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('ALERTS when only a claimed body identity is present (dashboard/api source)', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', anonymousNoise({ claimedEmail: 'cust-42' }));

      expect(mockRedis.incr).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('DROPS an expired dashboard session (source dashboard, no customer signal)', async () => {
      mockRedis.incr.mockResolvedValue(9);
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', anonymousNoise({ source: 'dashboard' }));

      expect(mockRedis.incr).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('scanner-noise classification — junk credentials', () => {
    // The exact fingerprint recipe of extract-claimed-identity.ts: an unrecognized-prefix
    // credential gets label 'key' + the first 12 hex chars of sha256(raw).
    function junkFingerprint(plaintext: string): string {
      return `key_${createHash('sha256').update(plaintext).digest('hex').slice(0, 12)}`;
    }

    it("pins the fingerprint of the key 'test': sha256('test') -> key_9f86d081884c", () => {
      expect(junkFingerprint('test')).toBe('key_9f86d081884c');
    });

    it('junk credential ("test") -> calm scanner-probe copy, NOT the customer-broke page', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      // SDK-looking UA clears the customer-shape gate, but the presented
      // credential was the literal word "test" (unrecognized prefix -> key_ label).
      await svc.recordFailure(
        'auth_401',
        identity({
          keyFingerprint: junkFingerprint('test'),
          recognizedCredential: false,
          claimedEmail: undefined,
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.text).toContain(':satellite:');
      expect(sent.text).toContain('scanner');
      expect(sent.text).toContain('junk credential');
      expect(sent.text).toContain('1.2.3.4');
      // The claimed/untrusted-id line stays in the noise copy (here: explicitly none).
      expect(sent.text).toContain('claimed/untrusted id');
      expect(sent.text).toContain('No customer impact; auth is doing its job');
      expect(sent.text).not.toContain("Likely a real customer's key broke");
      expect(sent.text).not.toContain('SDK auth failures detected');
      expect(sent.text).not.toContain('—'); // no em-dash leaking into Slack copy
    });

    it('junk fingerprint WITH a claimed email keeps the customer-broke wording (an onboarding customer pasting "YOUR_API_KEY" is not noise)', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      // identity() keeps its default claimedEmail 'cust@example.com': a real customer
      // mid-onboarding who copy-pasted a placeholder key still needs the page.
      await svc.recordFailure(
        'auth_401',
        identity({
          keyFingerprint: junkFingerprint('YOUR_API_KEY'),
          recognizedCredential: false,
        }),
      );

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.text).toContain('SDK auth failures detected');
      expect(sent.text).toContain("Likely a real customer's key broke");
      expect(sent.text).toContain('cust@example.com');
      expect(sent.text).not.toContain(':satellite:');
    });

    it('classifies every plaintext on the junk list, not just "test" (computed, not hardcoded)', async () => {
      for (const junk of ['null', 'YOUR_API_KEY', 'sk-test']) {
        jest.clearAllMocks();
        global.fetch = fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        mockRedis.incr.mockResolvedValueOnce(5);
        mockRedis.set.mockResolvedValueOnce('OK');
        const svc = makeService(buildConfig(fullEnv()));

        await svc.recordFailure(
          'auth_401',
          identity({ keyFingerprint: junkFingerprint(junk), claimedEmail: undefined }),
        );

        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.text).toContain(':satellite:');
      }
    });

    it('keeps the SAME threshold/dedupe mechanics: junk failures count in the same bucket and honor the cooldown', async () => {
      mockRedis.incr.mockResolvedValueOnce(4); // below threshold: counted, no page
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity({ keyFingerprint: junkFingerprint('test') }));

      expect(mockRedis.incr).toHaveBeenCalledWith('auth-failure:count:1.2.3.4');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a REAL-looking key (mf_sk_ fingerprint) keeps the existing customer-broke wording unchanged', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      // identity() default: keyFingerprint 'mf_sk_abcdef012345', a recognized credential.
      await svc.recordFailure('auth_401', identity());

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.text).toContain('SDK auth failures detected');
      expect(sent.text).toContain("Likely a real customer's key broke");
      expect(sent.text).not.toContain(':satellite:');
    });

    it('an UNRECOGNIZED but non-junk key (random garbage) also keeps the existing wording', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      // A key_ fingerprint of something NOT on the junk list must not be misclassified.
      await svc.recordFailure(
        'auth_401',
        identity({
          keyFingerprint: junkFingerprint('gAr8AgE-r4nd0m'),
          recognizedCredential: false,
        }),
      );

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.text).toContain('SDK auth failures detected');
      expect(sent.text).not.toContain(':satellite:');
    });
  });

  describe('revoked-key alert attribution', () => {
    const revokedFacts = {
      organizationId: 'org_rk',
      organizationName: 'Acme Co',
      keyLabel: 'Prod server key',
      revokedAt: new Date('2026-08-20T00:00:00.000Z'),
    };

    it('names the org, key label, and revocation date when the facts are present', async () => {
      mockRedis.incr.mockResolvedValue(5);
      mockRedis.set.mockResolvedValue('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', { ...identity(), revokedKey: revokedFacts });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.text).toContain('Revoked API key still in use');
      expect(sent.text).toContain('org:* Acme Co');
      expect(sent.text).toContain('key:* Prod server key');
      expect(sent.text).toContain('revoked:* Aug 20, 2026');
      expect(sent.text).toContain('1.2.3.4');
      expect(sent.text).not.toContain('SDK auth failures detected');
      expect(sent.text).not.toMatch(/[—–]/);
      // The full lookup hash must never leak into Slack (or anywhere).
      expect(sent.text).not.toMatch(/[0-9a-f]{64}/);
    });

    it('still buckets a revoked-key failure on the caller IP, never the org', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', { ...identity(), revokedKey: revokedFacts });

      // The facts are trusted attribution, not a trusted PRINCIPAL: the count
      // stays keyed on the observed IP so an unauthenticated caller can never
      // move counters into a real tenant's bucket.
      expect(mockRedis.incr).toHaveBeenCalledWith('auth-failure:count:1.2.3.4');
    });

    it('keeps the VERBATIM base copy when no revoked facts are present (keys with no stored hash)', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity());

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Pinned as a LITERAL so the fallback for revoked rows with a NULL hash
      // (no facts) can never silently drift.
      expect(sent.text).toBe(
        `:rotating_light: *SDK auth failures detected*\n` +
          `A caller has failed authentication 5 times in the last 15 min (threshold 5).\n` +
          `• *claimed/untrusted id:* cust@example.com\n` +
          `• *caller IP:* 1.2.3.4\n` +
          `• *path:* /v1/sdk/usage\n` +
          `• *source:* sdk\n` +
          `• *key fingerprint:* mf_sk_abcdef012345\n` +
          `_Likely a real customer's key broke (rotated/revoked/typo). The "claimed" ` +
          `id is from the rejected request body and is not verified._`,
      );
    });
  });

  describe('a login token at the ingest door gets its own auth_401 copy', () => {
    it('names the signed-in user and the auth method, and never claims a key broke', async () => {
      mockRedis.incr.mockResolvedValue(5);
      mockRedis.set.mockResolvedValue('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', {
        ...identity({ keyFingerprint: 'key_abcdef012345', recognizedCredential: false }),
        authMethodMismatch: { authMethod: 'jwt', email: 'human@acme.example' },
      });

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.text).toContain('Login token sent to the usage ingest endpoint');
      expect(sent.text).toContain('human@acme.example');
      expect(sent.text).toContain('auth method:* jwt');
      expect(sent.text).toContain('x-api-key');
      // The whole point: the default copy sends triage hunting for a key this
      // caller never presented.
      expect(sent.text).not.toContain('key broke');
      expect(sent.text).not.toContain('rotated');
      expect(sent.text).not.toMatch(/[—–]/);
    });

    it('still buckets on the caller IP, never on an org', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', {
        ...identity(),
        authMethodMismatch: { authMethod: 'jwt', email: 'human@acme.example' },
      });

      expect(mockRedis.incr).toHaveBeenCalledWith('auth-failure:count:1.2.3.4');
    });

    it('a revoked key still wins the copy when both sets of facts somehow arrive', async () => {
      mockRedis.incr.mockResolvedValue(5);
      mockRedis.set.mockResolvedValue('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', {
        ...identity(),
        revokedKey: {
          organizationId: 'org_rk',
          organizationName: 'Acme Co',
          keyLabel: 'Prod server key',
          revokedAt: new Date('2026-08-20T00:00:00.000Z'),
        },
        authMethodMismatch: { authMethod: 'jwt', email: 'human@acme.example' },
      });

      // Ordering pin: a named revoked key is the more actionable fact, so it
      // must stay above the auth-method-mismatch branch.
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.text).toContain('Revoked API key still in use');
    });
  });

  describe('owner-notice throttle (org-keyed cooldown, webhook-independent)', () => {
    const revokedFacts = {
      organizationId: 'org_rk',
      organizationName: 'Acme Co',
      keyLabel: 'Prod server key',
      revokedAt: new Date('2026-08-20T00:00:00.000Z'),
    };

    function revokedCtx(overrides: Partial<CustomerFailureContext> = {}): CustomerFailureContext {
      return { ...identity(), revokedKey: revokedFacts, ...overrides };
    }

    it('emails the owner on the FIRST attempt: attempts counter + org-keyed cooldown NX', async () => {
      mockRedis.incr.mockResolvedValueOnce(1); // attempts counter
      mockRedis.set.mockResolvedValueOnce('OK'); // notice cooldown acquired
      mockRedis.incr.mockResolvedValueOnce(1); // slack count (below threshold)
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', revokedCtx());

      expect(mockRedis.incr).toHaveBeenNthCalledWith(1, 'revoked-key-notice:attempts:org:org_rk');
      // First attempt anchors the counting window to the cooldown length.
      expect(mockRedis.expire).toHaveBeenCalledWith('revoked-key-notice:attempts:org:org_rk', 3600);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'revoked-key-notice:cooldown:org:org_rk',
        '1',
        'EX',
        3600,
        'NX',
      );
      expect(noticeNotify).toHaveBeenCalledTimes(1);
      expect(noticeNotify).toHaveBeenCalledWith(revokedFacts, 1);
    });

    it('TWO IPs, one org, both over threshold: two Slack alerts but ONE owner email', async () => {
      // call 1 (ip 1.2.3.4): attempts=1 → notice sent; slack count=5 → alert 1.
      // call 2 (ip 9.9.9.9): attempts=2, cooldown NX held → no email; slack count=5 → alert 2.
      mockRedis.incr
        .mockResolvedValueOnce(1) // attempts (call 1)
        .mockResolvedValueOnce(5) // slack count ip 1.2.3.4
        .mockResolvedValueOnce(2) // attempts (call 2)
        .mockResolvedValueOnce(5); // slack count ip 9.9.9.9
      mockRedis.set
        .mockResolvedValueOnce('OK') // notice cooldown (call 1) — acquired
        .mockResolvedValueOnce('OK') // slack cooldown ip 1.2.3.4
        .mockResolvedValueOnce(null) // notice cooldown (call 2) — held
        .mockResolvedValueOnce('OK'); // slack cooldown ip 9.9.9.9
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', revokedCtx());
      await svc.recordFailure('auth_401', revokedCtx({ callerIp: '9.9.9.9' }));

      // Two broken deployments → two Slack pages (correct), one owner email.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(noticeNotify).toHaveBeenCalledTimes(1);
    });

    it('the email decision does NOT depend on the Slack webhook', async () => {
      mockRedis.incr.mockResolvedValueOnce(1);
      mockRedis.set.mockResolvedValueOnce('OK');
      // Redis configured, webhook NOT: the email must still send.
      const svc = makeService(buildConfig({ REDIS_URL }));

      await svc.recordFailure('auth_401', revokedCtx());

      expect(noticeNotify).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled(); // nowhere to page, and that's fine
    });

    it('no Redis at all: no cooldown available, so NO email (fail-safe against spam)', async () => {
      const svc = makeService(buildConfig({}));

      await expect(svc.recordFailure('auth_401', revokedCtx())).resolves.toBeUndefined();

      expect(noticeNotify).not.toHaveBeenCalled();
    });

    it('a rejecting notify never propagates out of recordFailure', async () => {
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.set.mockResolvedValue('OK');
      noticeNotify.mockRejectedValueOnce(new Error('resend exploded'));
      const svc = makeService(buildConfig(fullEnv()));

      await expect(svc.recordFailure('auth_401', revokedCtx())).resolves.toBeUndefined();
    });

    it('honors a custom REVOKED_KEY_NOTICE_COOLDOWN_SECONDS knob', async () => {
      mockRedis.incr.mockResolvedValueOnce(1);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(
        buildConfig(fullEnv({ REVOKED_KEY_NOTICE_COOLDOWN_SECONDS: '7200' })),
      );

      await svc.recordFailure('auth_401', revokedCtx());

      expect(mockRedis.set).toHaveBeenCalledWith(
        'revoked-key-notice:cooldown:org:org_rk',
        '1',
        'EX',
        7200,
        'NX',
      );
    });

    it('a context WITHOUT revoked facts never touches the notice path', async () => {
      mockRedis.incr.mockResolvedValueOnce(1);
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity());

      expect(noticeNotify).not.toHaveBeenCalled();
      // The first (and only) INCR is the Slack counter, not the attempts key.
      expect(mockRedis.incr).toHaveBeenCalledTimes(1);
      expect(mockRedis.incr).toHaveBeenCalledWith('auth-failure:count:1.2.3.4');
    });
  });

  describe('IP-primary keying', () => {
    it('keys the counter on IP, so a varying-email flood from one IP cannot evade it', async () => {
      mockRedis.incr.mockResolvedValue(2);
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('auth_401', identity({ claimedEmail: 'a@evil.example' }));
      await svc.recordFailure('auth_401', identity({ claimedEmail: 'b@evil.example' }));

      // Both failures hit the SAME Redis key despite different claimed emails.
      expect(mockRedis.incr).toHaveBeenNthCalledWith(1, 'auth-failure:count:1.2.3.4');
      expect(mockRedis.incr).toHaveBeenNthCalledWith(2, 'auth-failure:count:1.2.3.4');
    });
  });

  // ---- the POST-AUTH classes ----

  describe('bad_data (400/422)', () => {
    it('keys on org (trusted), fires a "malformed events" alert at its default threshold (5)', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('bad_data', trustedCtx());

      // Trusted → org-keyed bucket in the bad-data namespace, NOT the IP.
      expect(mockRedis.incr).toHaveBeenCalledWith('customer-failure:bad-data:count:org:org_123');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'customer-failure:bad-data:cooldown:org:org_123',
        '1',
        'EX',
        3600,
        'NX',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Pinned copy, colon not em dash, with trusted org attribution.
      expect(sent.text).toContain('malformed events: every POST is being dropped');
      expect(sent.text).toContain('Acme Co');
      expect(sent.text).toContain('ops@acme.example');
      expect(sent.text).not.toContain('—'); // no em-dash leaking into Slack copy
    });

    it('skips the scanner gate for a trusted failure that has no SDK/claimed signal', async () => {
      // No claimedEmail, no recognizedCredential, source 'api' — would be DROPPED
      // if untrusted. But organizationId makes it trusted → it must still count.
      mockRedis.incr.mockResolvedValueOnce(1);
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure(
        'bad_data',
        trustedCtx({ source: 'api', email: undefined, organizationName: undefined }),
      );

      expect(mockRedis.incr).toHaveBeenCalledWith('customer-failure:bad-data:count:org:org_123');
    });
  });

  describe('forbidden (403 — publishable-key write)', () => {
    it('fires a publishable-key alert keyed on org', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('forbidden', trustedCtx({ method: 'POST' }));

      expect(mockRedis.incr).toHaveBeenCalledWith('customer-failure:forbidden:count:org:org_123');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.text).toContain('publishable key');
      expect(sent.text).toContain('403');
    });
  });

  describe('rate_limit (429 — GROWTH signal, distinct treatment)', () => {
    it('uses its OWN higher default threshold (50): does NOT fire at count 5', async () => {
      mockRedis.incr.mockResolvedValueOnce(5); // would fire for bad_data, NOT here
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('rate_limit', trustedCtx());

      // Counted in its own namespace, but below the 50 threshold → no alert.
      expect(mockRedis.incr).toHaveBeenCalledWith('customer-failure:rate-limit:count:org:org_123');
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fires a GROWTH-framed alert at its own threshold (50) with distinct copy', async () => {
      mockRedis.incr.mockResolvedValueOnce(50);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      await svc.recordFailure('rate_limit', trustedCtx());

      // Its OWN 6-hour cooldown, distinct from the 1-hour incident cooldown.
      expect(mockRedis.set).toHaveBeenCalledWith(
        'customer-failure:rate-limit:cooldown:org:org_123',
        '1',
        'EX',
        21600,
        'NX',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Growth framing + chart emoji, and explicitly NOT incident copy.
      expect(sent.text).toContain('they may want to send more');
      expect(sent.text).toContain(':chart_with_upwards_trend:');
      expect(sent.text).toContain('growth signal, not an incident');
      expect(sent.text).not.toContain(':rotating_light:');
    });

    it('honors a custom rate_limit threshold from its own env knob', async () => {
      mockRedis.incr.mockResolvedValueOnce(3);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv({ CUSTOMER_FAILURE_RATE_LIMIT_THRESHOLD: '3' })));

      await svc.recordFailure('rate_limit', trustedCtx());

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('trusted vs untrusted bucketing', () => {
    it('falls back to IP keying when no org is present (e.g. a public-route 400)', async () => {
      mockRedis.incr.mockResolvedValueOnce(5);
      mockRedis.set.mockResolvedValueOnce('OK');
      const svc = makeService(buildConfig(fullEnv()));

      // Untrusted bad_data: no organizationId, but SDK-shaped so it clears the gate.
      await svc.recordFailure('bad_data', {
        callerIp: '9.9.9.9',
        source: 'sdk',
        path: '/v1/public/thing',
      });

      expect(mockRedis.incr).toHaveBeenCalledWith('customer-failure:bad-data:count:9.9.9.9');
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Untrusted attribution: claimed/untrusted + IP, not a verified org line.
      expect(sent.text).toContain('caller IP');
    });
  });

  describe('fail-open posture (never throw, never alert when degraded)', () => {
    it('no-ops (no INCR, no throw) when no REDIS_URL is configured', async () => {
      const svc = makeService(buildConfig({ AUTH_FAILURE_SLACK_WEBHOOK_URL: WEBHOOK }));

      await expect(svc.recordFailure('auth_401', identity())).resolves.toBeUndefined();
      await expect(svc.recordFailure('bad_data', trustedCtx())).resolves.toBeUndefined();
      expect(mockRedis.incr).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no-ops (no INCR) when Redis is present but no Slack webhook is configured', async () => {
      const svc = makeService(buildConfig({ REDIS_URL }));

      await svc.recordFailure('auth_401', identity());

      // Nowhere to alert → don't even accumulate counter keys.
      expect(mockRedis.incr).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('swallows a Redis error and never throws (the response is untouched)', async () => {
      mockRedis.incr.mockRejectedValueOnce(new Error('ECONNRESET'));
      const svc = makeService(buildConfig(fullEnv()));

      await expect(svc.recordFailure('auth_401', identity())).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('swallows a non-2xx Slack response without throwing (rate_limit path)', async () => {
      mockRedis.incr.mockResolvedValueOnce(50);
      mockRedis.set.mockResolvedValueOnce('OK');
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
      const svc = makeService(buildConfig(fullEnv()));

      await expect(svc.recordFailure('rate_limit', trustedCtx())).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('honors REDIS_URL_REDIS_URL (hosted-integration double prefix) like the throttler', async () => {
      mockRedis.incr.mockResolvedValueOnce(1);
      const svc = makeService(
        buildConfig({
          REDIS_URL_REDIS_URL: 'redis://upstash.example.com:6379',
          AUTH_FAILURE_SLACK_WEBHOOK_URL: WEBHOOK,
        }),
      );

      await svc.recordFailure('auth_401', identity());
      expect(mockRedis.incr).toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('quits Redis on module destroy', async () => {
      const svc = makeService(buildConfig(fullEnv()));
      await svc.onModuleDestroy();
      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });
});
