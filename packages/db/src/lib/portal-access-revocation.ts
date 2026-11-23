/**
 * portal-access-revocation.ts — the ONE portal-access cascade both
 * revoke doors run.
 *
 * Revoking a secret key must end every portal magic link and portal session it
 * could have minted, in the same instant. Neither portal table stores which key
 * minted a row (no apiKeyId column — schema.prisma portal_sessions /
 * portal_magic_links), so the cascade is deliberately org-scoped: a secret-key
 * revoke ends ALL of the org's live portal access, and an affected customer
 * requests a fresh link. Lineage-precise revocation would need an apiKeyId
 * column on both tables.
 *
 * WHY expire instead of delete: an EXPIRED magic link still resolves its org at
 * the dashboard redeem route, so the customer lands on the org-branded
 * "link expired, request a new one" page. A DELETED link cannot resolve the org
 * and falls through to the unbranded invalid-link page. Deletion is equally
 * secure; expiry gives the customer the page that explains what to do.
 *
 * WHY the WHERE filters to still-live rows: the returned counts are shown to the
 * person revoking. Filtering to unexpired (and, for links, unused) rows keeps
 * those counts honest — we never claim to have ended access that was already dead.
 *
 * WHY this lives here (same shape as spend-coverage.ts):
 * the dashboard revoke/delete actions AND api-nest's revoke endpoint all make the
 * same trust claim. One helper, called from both sides, so the doors cannot drift.
 */

/**
 * The tiny slice of a Prisma client this cascade touches. Structural on purpose
 * so BOTH callers pass their own client with no cast: the dashboard's client
 * and api-nest's PrismaService (or either one's interactive
 * transaction client).
 */
export interface PortalAccessRevocationClient {
  portal_magic_links: {
    // Foot-gun: method syntax + open args are load-bearing (see the identical
    // note in spend-coverage.ts) — narrowing to arrow props or literal arg
    // types breaks assignability for one of the concrete clients.
    updateMany(args?: unknown): Promise<{ count: number }>;
  };
  portal_sessions: {
    updateMany(args?: unknown): Promise<{ count: number }>;
  };
}

export interface PortalAccessRevoked {
  /** Live, unused magic links whose expiry was pulled into the past. */
  magicLinksEnded: number;
  /** Live portal sessions whose expiry was pulled into the past. */
  portalSessionsEnded: number;
}

/**
 * End every live portal magic link and portal session for one org by expiring
 * them. Run inside the same transaction as the key-revoke write so a partial
 * failure rolls the whole revoke back.
 */
export async function revokePortalAccessForOrg(
  client: PortalAccessRevocationClient,
  organizationId: string,
): Promise<PortalAccessRevoked> {
  const now = new Date();
  // One full second in the past, never `now` itself: every reader compares
  // expiresAt with a strict gt/lt, so a same-millisecond value can still read
  // as live for the rest of that millisecond.
  const killedAt = new Date(now.getTime() - 1000);

  const links = await client.portal_magic_links.updateMany({
    where: {
      organizationId,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { expiresAt: killedAt },
  });

  const sessions = await client.portal_sessions.updateMany({
    where: {
      organizationId,
      expiresAt: { gt: now },
    },
    data: { expiresAt: killedAt },
  });

  return {
    magicLinksEnded: links.count,
    portalSessionsEnded: sessions.count,
  };
}
