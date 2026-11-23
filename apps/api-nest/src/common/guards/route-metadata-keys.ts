/**
 * Route-metadata keys read by MORE THAN ONE guard. A key lives here the moment a second
 * guard needs it, so a rename is a compile-level fact instead of a silent behavior change
 * in whichever file still holds the old string. Deliberately import-free: org-role.guard.ts
 * pulls in @marginfront/db at module load, and the publishable-key specs must stay bootable
 * without a built dist (see ORG_MANAGE_ROLES in org-role.guard.ts for the full hazard).
 */

/**
 * Marks the pure usage-INGEST path (the usage-record POSTs). Read by
 * OrgRoleGuard (role short-circuit) and PublishableKeyReadGuard (the
 * deny-by-default carve-out that leaves the pk ingest 403 to the write interceptor).
 * Controllers use the @IngestRoute() decorator in org-role.guard.ts, never this string.
 */
export const INGEST_ROUTE_KEY = 'ingestRoute';

/**
 * Carries the role list an @OrgRoles(...) decorator stamped on a route. Read by
 * OrgRoleGuard (the role check itself) and LegalKeyScopeGuard (a route whose
 * list includes 'legal' is inside the legal key's reachable surface). Lives here
 * because two guards read it, per the header rule above.
 * Controllers use the @OrgRoles() decorator in org-role.guard.ts, never this string.
 */
export const ORG_ROLES_KEY = 'orgRoles';
