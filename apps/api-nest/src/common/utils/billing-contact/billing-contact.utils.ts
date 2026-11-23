/**
 * The one resolver for an org's billing contact email: billing_email (explicit
 * API-set value) → billingIdentity.email (the /settings/billing "Billing email"
 * field) → null. Callers own the null fallback: merchant notifications may fall
 * back to current owner-role members; customer-facing surfaces MUST NOT (owner
 * personal emails must never print on customer invoices). billingIdentity is an
 * untyped JSON column, so malformed shapes fall through silently — this runs
 * inside billing dispatch and must never throw.
 */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveOrgBillingContactEmail(
  org:
    | {
        billing_email?: string | null;
        billingIdentity?: unknown;
      }
    | null
    | undefined,
): string | null {
  if (!org) return null;

  if (typeof org.billing_email === 'string' && org.billing_email.trim() !== '') {
    return org.billing_email.trim();
  }

  const identity = org.billingIdentity;
  if (identity && typeof identity === 'object' && !Array.isArray(identity)) {
    const identityEmail = (identity as Record<string, unknown>).email;
    if (typeof identityEmail === 'string') {
      const trimmed = identityEmail.trim();
      if (EMAIL_SHAPE.test(trimmed)) {
        return trimmed;
      }
    }
  }

  return null;
}
