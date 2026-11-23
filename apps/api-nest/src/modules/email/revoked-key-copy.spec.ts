/**
 * Literal-string pins for the revoked-key owner-notice copy.
 * Pinned VERBATIM, like cap-alert-copy.spec.ts: this copy lands in a customer
 * owner's inbox, so any wording change must be a deliberate diff here, never a
 * silent drift. The date is UTC-formatted; the attempt count pluralizes.
 */
import { buildRevokedKeyNoticeContent } from './revoked-key-copy';

const REVOKED_AT = new Date('2026-08-20T14:30:00.000Z');

describe('buildRevokedKeyNoticeContent', () => {
  it('builds the exact notice for a single attempt', () => {
    expect(
      buildRevokedKeyNoticeContent({
        keyLabel: 'Prod server key',
        revokedAt: REVOKED_AT,
        attempts: 1,
      }),
    ).toEqual({
      subject: 'A revoked API key is still being used',
      headline: 'A revoked key is still in use',
      whatHappened:
        'The key "Prod server key" was revoked on Aug 20, 2026. ' +
        "Something is still sending it to the API. We've turned it away 1 time so far.",
      whatItMeans:
        "Whatever sends that key isn't getting through. If it's one of your " +
        "services, its usage isn't being recorded.",
      whatToDo:
        'Create a new key in Build > API keys, then update the app or service that ' +
        'still uses the old one.',
    });
  });

  it('pluralizes the attempt count', () => {
    const c = buildRevokedKeyNoticeContent({
      keyLabel: 'CI key',
      revokedAt: REVOKED_AT,
      attempts: 12,
    });
    expect(c.whatHappened).toContain("We've turned it away 12 times so far.");
  });

  it('formats the revocation date in UTC (no server-timezone drift)', () => {
    // 2026-08-20T23:30Z is already Aug 21 in UTC+2 — the copy must stay Aug 20.
    const c = buildRevokedKeyNoticeContent({
      keyLabel: 'k',
      revokedAt: new Date('2026-08-20T23:30:00.000Z'),
      attempts: 1,
    });
    expect(c.whatHappened).toContain('revoked on Aug 20, 2026');
  });
});
