/**
 * Authentication Guards
 *
 * MarginFront uses a tiered authentication system:
 *
 * 1. SecretKeyGuard (mf_sk_*) - Server-side only
 *    - Creating portal sessions
 *    - Managing customers
 *    - Recording usage events
 *    - Full API access
 *
 * 2. PublishableKeyGuard (mf_pk_*) - mounted on zero routes
 *    - A publishable key is denied by default on every
 *      authenticated route; a route-scoped mount of this guard is dead code
 *      because the global PublishableKeyReadGuard denies the key first unless
 *      the route carries @PublishableKeyAllowed (three routes, ever)
 *
 * 3. PortalSessionGuard (prtl_*) - Customer portal access
 *    - Customer's own invoices
 *    - Customer's subscriptions
 *    - Customer's usage data
 *    - Scoped to single customer
 *
 * 4. OrgAccessGuard - Team member access validation
 *    - Verify user belongs to organization
 */

export { SecretKeyGuard } from './secret-key.guard';
export { PublishableKeyGuard } from './publishable-key.guard';
export { PortalSessionGuard, type PortalSessionRequest } from './portal-session.guard';
export { OrgAccessGuard } from './org-access.guard';
export { CronSecretGuard } from './cron-secret.guard';
