/**
 * WHAT THIS FILE DOES:
 *   Unit tests for extractClaimedIdentity — the pure attribution helper used by
 *   CombinedAuthGuard's reject path. Pins the security-critical behavior:
 *     - claimed-id precedence (records[0].customerExternalId > customerExternalId
 *       > email),
 *     - sanitization of attacker-controlled body content (control-char stripping
 *       + length cap),
 *     - Buffer / absent / non-object bodies degrade to undefined (never throw),
 *     - IP resolution mirrors PerTenantThrottlerGuard,
 *     - the credential fingerprint is one-way and NEVER leaks the raw key.
 */
import { createHash } from 'crypto';
import { extractClaimedIdentity } from './extract-claimed-identity';

function reqWith(overrides: Record<string, any> = {}): any {
  return {
    headers: {},
    ...overrides,
  };
}

describe('extractClaimedIdentity', () => {
  describe('claimedEmail precedence + parsing', () => {
    it('prefers records[0].customerExternalId (batch ingest shape)', () => {
      const id = extractClaimedIdentity(
        reqWith({
          body: {
            records: [{ customerExternalId: 'cust-from-records' }],
            customerExternalId: 'cust-top-level',
            email: 'fallback@example.com',
          },
        }),
      );
      expect(id.claimedEmail).toBe('cust-from-records');
    });

    it('falls back to body.customerExternalId (single ingest shape)', () => {
      const id = extractClaimedIdentity(
        reqWith({ body: { customerExternalId: 'cust-123', email: 'x@example.com' } }),
      );
      expect(id.claimedEmail).toBe('cust-123');
    });

    it('falls back to body.email when no customerExternalId present', () => {
      const id = extractClaimedIdentity(reqWith({ body: { email: 'owner@example.com' } }));
      expect(id.claimedEmail).toBe('owner@example.com');
    });

    it('returns undefined claimedEmail when records[0] has no customerExternalId', () => {
      const id = extractClaimedIdentity(reqWith({ body: { records: [{ quantity: 5 }] } }));
      expect(id.claimedEmail).toBeUndefined();
    });

    it('ignores a non-object first record without throwing', () => {
      const id = extractClaimedIdentity(reqWith({ body: { records: ['not-an-object'] } }));
      expect(id.claimedEmail).toBeUndefined();
    });
  });

  describe('sanitization of untrusted body content (SECURITY)', () => {
    it('strips CR/LF and other control chars to prevent log-line forgery', () => {
      // A crafted body trying to inject a fake "approved" log line.
      const malicious = 'evil@example.com\r\n[CombinedAuthGuard] APPROVED\u0000';
      const id = extractClaimedIdentity(reqWith({ body: { email: malicious } }));
      expect(id.claimedEmail).toBe('evil@example.com[CombinedAuthGuard] APPROVED');
      expect(id.claimedEmail).not.toContain('\n');
      expect(id.claimedEmail).not.toContain('\r');
      expect(id.claimedEmail).not.toContain('\u0000');
    });

    it('caps the claimed id at 120 chars to bound log + Redis key size', () => {
      const huge = 'a'.repeat(500);
      const id = extractClaimedIdentity(reqWith({ body: { email: huge } }));
      expect(id.claimedEmail).toHaveLength(120);
    });

    it('returns undefined for a non-string claimed value (numbers/objects)', () => {
      const id = extractClaimedIdentity(reqWith({ body: { email: { nested: true } } }));
      expect(id.claimedEmail).toBeUndefined();
    });

    it('returns undefined when the claimed value is only whitespace/control chars', () => {
      const id = extractClaimedIdentity(reqWith({ body: { email: '  \r\n\t  ' } }));
      expect(id.claimedEmail).toBeUndefined();
    });
  });

  describe('defensive body handling (NEVER THROWS)', () => {
    it('handles a Buffer body (Stripe raw-body route) with undefined claimedEmail', () => {
      const id = extractClaimedIdentity(
        reqWith({ body: Buffer.from('{"email":"shouldnotparse"}'), ip: '1.2.3.4' }),
      );
      expect(id.claimedEmail).toBeUndefined();
      expect(id.callerIp).toBe('1.2.3.4');
    });

    it('handles an absent body', () => {
      const id = extractClaimedIdentity(reqWith({ ip: '9.9.9.9' }));
      expect(id.claimedEmail).toBeUndefined();
      expect(id.callerIp).toBe('9.9.9.9');
    });

    it('does not throw on a completely empty request object', () => {
      expect(() => extractClaimedIdentity({})).not.toThrow();
      const id = extractClaimedIdentity({});
      expect(id.callerIp).toBe('unknown');
    });
  });

  describe('callerIp resolution (mirrors PerTenantThrottlerGuard)', () => {
    it('uses req.ips[0] (leftmost x-forwarded-for) first', () => {
      const id = extractClaimedIdentity(reqWith({ ips: ['1.1.1.1', '10.0.0.1'], ip: '5.5.5.5' }));
      expect(id.callerIp).toBe('1.1.1.1');
    });

    it('falls back to req.ip when req.ips is empty', () => {
      const id = extractClaimedIdentity(reqWith({ ips: [], ip: '5.5.5.5' }));
      expect(id.callerIp).toBe('5.5.5.5');
    });

    it('falls back to "unknown" when nothing identifies the caller', () => {
      const id = extractClaimedIdentity(reqWith({}));
      expect(id.callerIp).toBe('unknown');
    });
  });

  describe('source detection + path', () => {
    it('tags ccc traffic from the code-cost-clarity user-agent', () => {
      const id = extractClaimedIdentity(
        reqWith({
          headers: { 'user-agent': '@marginfront/code-cost-clarity/1.2.3' },
          url: '/v1/sdk/usage',
        }),
      );
      expect(id.source).toBe('ccc');
      expect(id.path).toBe('/v1/sdk/usage');
    });

    it('defaults source to api with no user-agent', () => {
      const id = extractClaimedIdentity(reqWith({ originalUrl: '/v1/sdk/usage' }));
      expect(id.source).toBe('api');
      // path falls back to originalUrl when url is absent.
      expect(id.path).toBe('/v1/sdk/usage');
    });
  });

  describe('credential fingerprint (SECURITY — never leak the raw key)', () => {
    const SECRET_KEY = 'mf_sk_supersecretvalue1234567890';

    it('returns a deterministic sha256-prefixed fingerprint, NOT the raw key', () => {
      const a = extractClaimedIdentity(reqWith({ headers: { 'x-api-key': SECRET_KEY } }));
      const b = extractClaimedIdentity(reqWith({ headers: { 'x-api-key': SECRET_KEY } }));

      expect(a.keyFingerprint).toBeDefined();
      // Deterministic so repeated bad-key failures correlate.
      expect(a.keyFingerprint).toBe(b.keyFingerprint);
      // The raw secret must never appear in the fingerprint.
      expect(a.keyFingerprint).not.toContain('supersecret');
      expect(a.keyFingerprint).not.toContain(SECRET_KEY);
    });

    it('labels a recognized key type and embeds a sha256 prefix', () => {
      const expectedDigest = createHash('sha256').update(SECRET_KEY).digest('hex').slice(0, 12);
      const id = extractClaimedIdentity(reqWith({ headers: { 'x-api-key': SECRET_KEY } }));
      expect(id.keyFingerprint).toBe(`mf_sk_${expectedDigest}`);
    });

    it('fingerprints a Bearer token when no x-api-key is present', () => {
      const id = extractClaimedIdentity(
        reqWith({ headers: { authorization: 'Bearer some.jwt.token' } }),
      );
      expect(id.keyFingerprint).toMatch(/^key_[0-9a-f]{12}$/);
    });

    it('returns undefined fingerprint when no credential is presented', () => {
      const id = extractClaimedIdentity(reqWith({ headers: {} }));
      expect(id.keyFingerprint).toBeUndefined();
    });
  });

  describe('recognizedCredential (drives the alert gate)', () => {
    it('is TRUE for a recognized MarginFront key prefix (mf_sk_)', () => {
      const id = extractClaimedIdentity(
        reqWith({ headers: { 'x-api-key': 'mf_sk_supersecretvalue1234567890' } }),
      );
      expect(id.recognizedCredential).toBe(true);
    });

    it('is FALSE for a Bearer token with no recognized prefix (scanner-style garbage)', () => {
      const id = extractClaimedIdentity(
        reqWith({ headers: { authorization: 'Bearer some.random.jwt' } }),
      );
      // Still fingerprinted (label "key") but NOT a recognized customer key.
      expect(id.keyFingerprint).toMatch(/^key_[0-9a-f]{12}$/);
      expect(id.recognizedCredential).toBe(false);
    });

    it('is FALSE when no credential is presented at all', () => {
      const id = extractClaimedIdentity(reqWith({ headers: {} }));
      expect(id.recognizedCredential).toBe(false);
    });
  });
});
