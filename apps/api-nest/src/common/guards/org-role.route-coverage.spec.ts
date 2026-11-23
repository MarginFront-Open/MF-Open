/**
 * Ship-blocking ROUTE-COVERAGE test.
 *
 * What this file proves: every state-changing route in the app carries BOTH
 * `@UseGuards(OrgRoleGuard)` and a role decorator (`@OrgRoles` or `@HumanOnly`) — so the
 * "OrgRoleGuard is the single choke point" claim is enforced by CI,
 * not by a reviewer remembering to check. A new POST/PUT/PATCH/DELETE route without the
 * guard fails THIS test.
 *
 * How it works (no mocking, no bootstrap): it walks every `*.controller.ts` file under
 * `src/modules` + `src/app.controller.ts`, `require()`s each one (loading the REAL classes
 * with their REAL decorators already applied), and reads the exact same
 * `Reflect.getMetadata` keys NestJS itself reads at request time
 * (`PATH_METADATA`/`METHOD_METADATA`/`GUARDS_METADATA` from `@nestjs/common/constants`, plus
 * the `orgRoles`/`humanOnly`/`ingestRoute`/`isPublic` keys this codebase's own decorators
 * write). It never boots a Nest application (no DB/Redis connection needed), so it's fast
 * and has no environment dependency — see `mint-ceiling.spec.ts` for the same
 * import-the-real-controller-and-read-its-metadata pattern this file scales up to every route.
 */

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { INGEST_ROUTE_KEY } from './route-metadata-keys';

const SRC_ROOT = path.join(__dirname, '..', '..');

const MUTATING_METHODS = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

interface DiscoveredRoute {
  key: string; // "ControllerName#handlerName", the identity used by every allowlist below
  file: string;
  httpMethod: string;
  guardNames: string[];
  hasOrgRoles: boolean; // true iff @OrgRoles(...) (even with zero roles) was ever applied
  hasHumanOnly: boolean;
  hasIngestRoute: boolean;
  isPublic: boolean;
}

function findControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findControllerFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every controller class exported by a `*.controller.ts` file, paired with every
 * POST/PUT/PATCH/DELETE handler it declares. GET is out of scope for this test — reads are
 * covered by org-role.privileged-read.spec.ts, not this route-coverage sweep.
 */
function discoverMutatingRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const file of findControllerFiles(path.join(SRC_ROOT, 'modules')).concat([
    path.join(SRC_ROOT, 'app.controller.ts'),
  ])) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- loads each controller file found on disk
    const mod = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctor = exported as new (...args: unknown[]) => unknown;
      const classPath = Reflect.getMetadata(PATH_METADATA, ctor);
      if (classPath === undefined) continue; // not a @Controller-decorated class
      const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctor) ?? [];
      const classIsPublic = Reflect.getMetadata('isPublic', ctor) ?? false;
      const proto = ctor.prototype;
      for (const handlerName of Object.getOwnPropertyNames(proto)) {
        if (handlerName === 'constructor') continue;
        const handler = proto[handlerName];
        const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler);
        if (httpMethod === undefined || !MUTATING_METHODS.has(httpMethod)) continue;
        const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        routes.push({
          key: `${ctor.name}#${handlerName}`,
          file: path.relative(SRC_ROOT, file),
          httpMethod: METHOD_NAMES[httpMethod],
          guardNames: [...classGuards, ...methodGuards].map(
            (g) => (g as { name?: string }).name ?? String(g),
          ),
          // getAllAndOverride semantics: method-level wins, else fall back to class-level.
          hasOrgRoles:
            Reflect.getMetadata('orgRoles', handler) !== undefined ||
            Reflect.getMetadata('orgRoles', ctor) !== undefined,
          hasHumanOnly:
            (Reflect.getMetadata('humanOnly', handler) ??
              Reflect.getMetadata('humanOnly', ctor)) === true,
          hasIngestRoute:
            (Reflect.getMetadata(INGEST_ROUTE_KEY, handler) ??
              Reflect.getMetadata(INGEST_ROUTE_KEY, ctor)) === true,
          isPublic: classIsPublic || (Reflect.getMetadata('isPublic', handler) ?? false) === true,
        });
      }
    }
  }
  return routes;
}

/**
 * Guards for callers who aren't org members at all (a portal customer, a cron job with a
 * shared secret) — OrgRoleGuard's "which org role does this caller carry" question doesn't
 * apply to them. A route guarded by one of these and NOT also OrgRoleGuard is out of scope.
 */
const ALTERNATE_AUTH_GUARD_NAMES = new Set([
  'PortalSessionGuard',
  'SecretKeyGuard',
  'CronSecretGuard',
]);

/**
 * Routes that are legitimately outside OrgRoleGuard's job because there is no existing org
 * membership to check a role against. Each entry is verified against the handler, not assumed.
 */
const STRUCTURALLY_EXEMPT = new Set([
  // Self-service on the caller's OWN user row (`PATCH /users/me`) — not an org action, so
  // there is no org-scoped role to check.
  'UsersController#updateCurrentUser',
  // Accepting an invitation happens BEFORE the caller is a member of the target org (see the
  // in-file comment on InvitationsController) — there is no membership yet to gate on.
  'InvitationsController#acceptInvitation',
  // Creating an org: there is no existing org to check a role against yet.
  'OrganizationsController#createOrganization',
  // requireHumanAuth() throws for EVERY api-key request outright (not merely the wrong role)
  // — a strictly stronger guarantee than @HumanOnly()+OrgRoleGuard would add on top, wired
  // via a manual check instead of the decorator. Not a gap, a different mechanism
  // reaching the same "no API key, ever" property.
  'OrganizationsController#updateOrganization',
  'OrganizationsController#deleteOrganization',
  // Pure computation/scraping/LLM-preview calls — no organizationId in their DTOs, no Prisma
  // write of any kind, nothing org-scoped happens. previewBillingSetup/extractCompanyData say
  // so in their own doc comments ("without creating any records" / "without creating anything").
  'OnboardingController#getScreenshot',
  'OnboardingController#enhancedPreview',
  'OnboardingController#extractCompanyData',
  'OnboardingController#previewBillingSetup',
]);

/**
 * Unguarded-route allowlist. It is EMPTY and must stay empty. The routes most at risk of
 * losing their guard are in GUARD_CANARY_ROUTES below, which asserts each one stays guarded.
 * Never add a NEW route here; an uncovered new route should fail the main sweep loudly, not
 * get grandfathered in.
 */
const UNGUARDED_ROUTE_ALLOWLIST = new Set<string>([]);

/**
 * Routes whose authorization is easy to lose. Each carries OrgRoleGuard + a role decorator,
 * so `isCovered` returns true for it AND it is subject to the main coverage sweep above.
 * This canary pins them: if an edit strips the guard off any of these, this
 * test fails FIRST with the exact route name.
 *   1. Onboarding cross-tenant WRITE (createFromEnhancedPreview/onboardFromWebsite/quickOnboard)
 *      — proves ba_member membership in dto.organizationId (OnboardingController).
 *   2. InvoiceCalculator cross-tenant READ (calculateInvoice/simulateRevenue) — lookups are
 *      org-scoped so a cross-org id 404s.
 *   3. SDK invoice alias (generateInvoice/sendInvoice) — MANAGE_MONEY_ROLES-gated.
 */
const GUARD_CANARY_ROUTES = [
  'SdkController#generateInvoice',
  'SdkController#sendInvoice',
  'InvoiceCalculatorController#calculateInvoice',
  'InvoiceCalculatorController#simulateRevenue',
  'OnboardingController#createFromEnhancedPreview',
  'OnboardingController#onboardFromWebsite',
  'OnboardingController#quickOnboard',
];

function isCovered(route: DiscoveredRoute): boolean {
  return route.guardNames.includes('OrgRoleGuard') && (route.hasOrgRoles || route.hasHumanOnly);
}

function isExemptFromCoverage(route: DiscoveredRoute): boolean {
  if (route.isPublic) return true; // @Public — no authz surface at all
  if (route.hasIngestRoute) return true; // ingest — allowed before role is ever read
  if (route.guardNames.includes('CombinedAuthGuard') === false) {
    // A route whose only class-level guard is one of the alternate auth mechanisms (and
    // doesn't ALSO carry OrgRoleGuard) authenticates via a non-org-role scheme entirely.
    const hasAlternateGuard = route.guardNames.some((g) => ALTERNATE_AUTH_GUARD_NAMES.has(g));
    if (hasAlternateGuard && !route.guardNames.includes('OrgRoleGuard')) return true;
  }
  if (STRUCTURALLY_EXEMPT.has(route.key)) return true;
  if (UNGUARDED_ROUTE_ALLOWLIST.has(route.key)) return true;
  return false;
}

describe('Route coverage — every state-changing route carries OrgRoleGuard + a role decorator', () => {
  const routes = discoverMutatingRoutes();

  it('discovery actually walked the controller tree (sanity check the sweep itself works)', () => {
    // A drop here means the file-walk or metadata read broke, NOT that the app got
    // safer — if this drops to 0 every other assertion in this file passes vacuously.
    expect(routes.length).toBeGreaterThan(60);
  });

  it('the same route never appears twice (discovery is deduped by construction)', () => {
    const keys = routes.map((r) => `${r.file}:${r.key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  const subjectToCoverage = routes.filter((r) => !isExemptFromCoverage(r));

  it('at least one route is actually subject to this sweep (not everything got exempted)', () => {
    expect(subjectToCoverage.length).toBeGreaterThan(40);
  });

  it.each(subjectToCoverage.map((r) => [r.key, r] as const))(
    '%s carries OrgRoleGuard + a role decorator',
    (_key, route) => {
      expect(route.guardNames).toContain('OrgRoleGuard');
      expect(route.hasOrgRoles || route.hasHumanOnly).toBe(true);
    },
  );

  describe('easily-lost guards stay in place', () => {
    it('the unguarded-route allowlist is empty', () => {
      expect(UNGUARDED_ROUTE_ALLOWLIST.size).toBe(0);
    });

    it.each(GUARD_CANARY_ROUTES)(
      '%s carries OrgRoleGuard + a role decorator (regression canary — FAILS if the guard is removed)',
      (key) => {
        const route = routes.find((r) => r.key === key);
        expect(route).toBeDefined();
        expect(isCovered(route as DiscoveredRoute)).toBe(true);
      },
    );
  });
});
