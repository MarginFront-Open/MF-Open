/**
 * RevokedKeyNoticeService unit tests. Pins, in order of blast
 * radius:
 *   - the notice carries the key label, revoke date and attempt count.
 *   - recipient resolution delegates to resolveAlertRecipients: billing
 *     contact wins; else every current owner/finance ba_member, deduped
 *     case-insensitively; never organizations.owner_id.
 *   - zero recipients → no send, no throw.
 *   - a rejecting send never propagates out of notify (the 401 path must be
 *     unaffected by email trouble).
 */
import { RevokedKeyNoticeService } from './revoked-key-notice.service';
import type { RevokedKeyFacts } from '../../common/exceptions/revoked-api-key.exception';

function facts(over: Partial<RevokedKeyFacts> = {}): RevokedKeyFacts {
  return {
    organizationId: 'org-1',
    organizationName: 'Acme Co',
    keyLabel: 'Prod server key',
    revokedAt: new Date('2026-08-20T00:00:00.000Z'),
    ...over,
  };
}

function buildService(opts: {
  org?: { billing_email?: string | null; billingIdentity?: unknown } | null;
  members?: Array<{ users: { email: string | null } | null }>;
  sendRejects?: boolean;
}) {
  const findUnique = jest.fn().mockResolvedValue(opts.org ?? null);
  const findMany = jest.fn().mockResolvedValue(opts.members ?? []);
  const sendRevokedKeyInUseEmail = opts.sendRejects
    ? jest.fn().mockRejectedValue(new Error('resend down'))
    : jest.fn().mockResolvedValue({ id: 'email-1' });

  const prisma = {
    organizations: { findUnique },
    ba_member: { findMany },
  } as any;
  const emailService = { sendRevokedKeyInUseEmail } as any;
  const service = new RevokedKeyNoticeService(prisma, emailService);
  return { service, findUnique, findMany, sendRevokedKeyInUseEmail };
}

describe('RevokedKeyNoticeService', () => {
  it('sends the notice with the key label, revoke date and attempt count', async () => {
    const { service, sendRevokedKeyInUseEmail } = buildService({
      org: { billing_email: 'billing@acme.test' },
    });

    await service.notify(facts(), 3);

    expect(sendRevokedKeyInUseEmail).toHaveBeenCalledTimes(1);
    expect(sendRevokedKeyInUseEmail).toHaveBeenCalledWith({
      to: 'billing@acme.test',
      keyLabel: 'Prod server key',
      revokedAt: new Date('2026-08-20T00:00:00.000Z'),
      attempts: 3,
    });
  });

  it('the billing contact wins: one email, and the member fallback is never queried', async () => {
    const { service, findMany, sendRevokedKeyInUseEmail } = buildService({
      org: { billing_email: 'billing@acme.test' },
      members: [{ users: { email: 'owner@acme.test' } }],
    });

    await service.notify(facts(), 1);

    expect(findMany).not.toHaveBeenCalled();
    expect(sendRevokedKeyInUseEmail).toHaveBeenCalledTimes(1);
  });

  it('falls back to current owner/finance members, deduped case-insensitively', async () => {
    const { service, findMany, sendRevokedKeyInUseEmail } = buildService({
      org: { billing_email: null, billingIdentity: null },
      members: [
        { users: { email: 'owner@acme.test' } },
        { users: { email: 'OWNER@acme.test' } },
        { users: { email: 'finance@acme.test' } },
        { users: null },
      ],
    });

    await service.notify(facts(), 2);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(sendRevokedKeyInUseEmail).toHaveBeenCalledTimes(2);
    const recipients = sendRevokedKeyInUseEmail.mock.calls.map((c: any[]) => c[0].to);
    expect(recipients).toEqual(['owner@acme.test', 'finance@acme.test']);
  });

  it('zero recipients: no send, no throw', async () => {
    const { service, sendRevokedKeyInUseEmail } = buildService({
      org: { billing_email: null, billingIdentity: null },
      members: [],
    });

    await expect(service.notify(facts(), 1)).resolves.toBeUndefined();
    expect(sendRevokedKeyInUseEmail).not.toHaveBeenCalled();
  });

  it('a rejecting send never propagates out of notify', async () => {
    const { service } = buildService({
      org: { billing_email: 'billing@acme.test' },
      sendRejects: true,
    });

    await expect(service.notify(facts(), 5)).resolves.toBeUndefined();
  });
});
