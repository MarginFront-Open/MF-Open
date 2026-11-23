import { CAP_MANAGE_ROLES } from '@marginfront/db';
import { resolveOrgBillingContactEmail } from './billing-contact.utils';

/**
 * Who hears a spend/pool alert. Cap alerts and credit-pool alerts share ONE
 * recipient rule: the org's billing contact email, else every current owner/finance member.
 * The alias exists so the pool evaluator reads as "alert recipients" without
 * re-declaring the role set — CAP_MANAGE_ROLES stays the single source.
 */
export const ALERT_RECIPIENT_ROLES = CAP_MANAGE_ROLES;

/**
 * The one Prisma slice this resolver touches — structural (the
 * CoverageQueryClient pattern) so both PrismaService and test mocks satisfy
 * it with no cast.
 */
export interface AlertRecipientQueryClient {
  ba_member: {
    findMany(args?: unknown): Promise<unknown[]>;
  };
}

/**
 * Alert recipients: the billing contact, else every
 * current owner/finance member. The fallback reads current ba_member rows,
 * never organizations.owner_id — that create-time stamp can dangle to a
 * removed user. Empty = the caller skips without burning the
 * rung/stage.
 */
export async function resolveAlertRecipients(
  prisma: AlertRecipientQueryClient,
  orgId: string,
  org: { billing_email?: string | null; billingIdentity?: unknown } | null,
): Promise<string[]> {
  const billingContact = resolveOrgBillingContactEmail(org);
  if (billingContact) return [billingContact];

  const fallbackMembers = (await prisma.ba_member.findMany({
    where: { organizationId: orgId, role: { in: [...ALERT_RECIPIENT_ROLES] } },
    select: { users: { select: { email: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })) as Array<{ users?: { email?: string | null } | null }>;
  const emailsByLowercase = new Map<string, string>();
  for (const member of fallbackMembers) {
    const email = member.users?.email;
    if (email && !emailsByLowercase.has(email.toLowerCase())) {
      emailsByLowercase.set(email.toLowerCase(), email);
    }
  }
  return [...emailsByLowercase.values()];
}
