/**
 * The route-sweep CI lock for the legal-role key boundary, a structural twin
 * of the ingest sweep (ingest-key-scope.route-sweep.spec.ts) one role up.
 *
 * Same shape, same reason. Deny-by-default means an undecorated new route is the SAFE
 * state:
 *
 *   undecorated == DENIED == SAFE == CI GREEN.
 *
 * What fails CI here is a route gaining 'legal' in its @OrgRoles list, or a new
 * @IngestKeyAllowed / @IngestRoute grant, that isn't on the allowlists below. Growing
 * either allowlist is a product decision about what a law firm's API key may reach, never a
 * convenience — see LegalKeyScopeGuard's header for why the confinement exists at all.
 *
 * Same machinery as the ingest sweep: walk every controller file, load the REAL classes,
 * read the SAME metadata Nest reads at request time (getAllAndOverride semantics: method
 * overrides class), drive the REAL guard. No app boot, no DB.
 *
 * What this file locks:
 *   1. The set of handlers whose effective @OrgRoles metadata includes 'legal' is EXACTLY
 *      the 13 MattersController handlers.
 *   2. The ingest-parity surface (the same @IngestKeyAllowed six plus the two
 *      @IngestRoute usage POSTs that an ingest key can reach) is EXACTLY eight handlers,
 *      independently reachable by a legal key per LegalKeyScopeGuard's own design.
 *   3. The COMPLETE surface an explicit legal key can reach through the real guard is
 *      those 13 plus those 8 — 21 handlers, nothing else, every method — PLUS every
 *      @Public handler, which the guard allows defensively even when a fabricated
 *      context hands it a legal-role user (@Public routes never carry request.user in
 *      prod; CombinedAuthGuard doesn't run auth on them).
 *   4. Every other authenticated route denies through the real guard, GETs included.
 *      RequestMethod.GET === 0, and a truthiness check on METHOD_METADATA in a discovery
 *      loop silently drops every GET — discovery asserts GETs were found so this sweep
 *      can't pass by walking nothing.
 *   5. LegalKeyScopeGuard is global-only (zero @UseGuards mounts) — no route can opt out
 *      of it.
 */

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionContext, Logger, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { LegalKeyScopeGuard } from './legal-key-scope.guard';
import { LegalKeyScopeForbiddenException } from '../exceptions/legal-key-scope-forbidden.exception';
import { INGEST_KEY_ALLOWED_KEY } from './ingest-key-scope.guard';
import { INGEST_ROUTE_KEY, ORG_ROLES_KEY } from './route-metadata-keys';
import { MattersController } from '../../modules/matters/matters.controller';
import { CostControlController } from '../../modules/cost-control/cost-control.controller';
import { SdkController } from '../../modules/sdk/sdk.controller';
import { SdkPublicAliasesController } from '../../modules/sdk/sdk-public-aliases.controller';

const SRC_ROOT = path.join(__dirname, '..', '..');
const IS_PUBLIC_KEY = 'isPublic';

/**
 * The Law surface: every handler whose effective @OrgRoles metadata includes 'legal'.
 * Keyed on the handler, never on a path string, matching the ingest sweep's convention —
 * a path-keyed list would silently miss a duplicate handler mounted under two paths.
 */
const MATTERS_LEGAL_ROLE_ALLOWLIST = [
  'MattersController#applyRules',
  'MattersController#assignEvent',
  'MattersController#createMatter',
  'MattersController#createRule',
  'MattersController#deleteMatter',
  'MattersController#deleteRule',
  'MattersController#getAudit',
  'MattersController#getMatter',
  'MattersController#getUnassigned',
  'MattersController#listMatters',
  'MattersController#listRules',
  'MattersController#updateMatter',
  'MattersController#updateRule',
];

/**
 * The ingest-parity surface: the exact set an ingest-role key can reach (the ingest guard's own
 * allowlist plus its two @IngestRoute handlers), reachable by a legal key for the same
 * reason it's reachable by an ingest key — LegalKeyScopeGuard reads the identical
 * metadata. Copied by value, not imported from the ingest sweep spec (a test file, not a
 * source module), so if the ingest allowlist ever changes, this one must be updated too,
 * and a diff here is the signal to check that file.
 */
const INGEST_PARITY_ALLOWLIST = [
  'CostControlController#getCoverage',
  'CostControlController#getSpend',
  'CostControlController#listCaps',
  'SdkController#recordUsage',
  'SdkController#verifyApiKey',
  'SdkPublicAliasesController#recordUsage',
  'SdkPublicAliasesController#verifyApiKey',
  'SdkPublicAliasesController#whoami',
];

/** The complete non-public surface: 13 Law handlers + 8 ingest-parity handlers. */
const LEGAL_KEY_ALLOWLIST = [...MATTERS_LEGAL_ROLE_ALLOWLIST, ...INGEST_PARITY_ALLOWLIST].sort();

/**
 * Named representatives of what a legal key must NOT reach — the exact categories
 * LegalKeyScopeForbiddenException's message names (customers, invoices, revenue,
 * payouts). Pinned by name so re-opening any of them deletes a line saying what it's
 * re-opening. The behavioral sweep below covers the whole route set and stays correct on
 * its own as routes come and go.
 */
const CLOSED_EXPOSURE_REPRESENTATIVES = [
  ['AnalyticsController#getMrr', 'MRR'],
  ['InvoicesController#getInvoices', 'every invoice'],
  ['CustomersController#getCustomers', 'the customer roster with emails'],
  ['PortalSessionsController#createPortalSession', 'minting a customer portal token'],
] as const;

interface DiscoveredRoute {
  key: string;
  method: string;
  guardNames: string[];
  isPublic: boolean;
  hasIngestRoute: boolean;
  ingestKeyAllowed: boolean;
  legalViaOrgRoles: boolean;
  ctor: new (...args: unknown[]) => unknown;
  handlerName: string;
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

function discoverRoutes(): DiscoveredRoute[] {
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
      if (classPath === undefined) continue;
      const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctor) ?? [];
      const classIsPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctor) ?? false;
      const proto = ctor.prototype;
      for (const handlerName of Object.getOwnPropertyNames(proto)) {
        if (handlerName === 'constructor') continue;
        const handler = proto[handlerName];
        if (typeof handler !== 'function') continue;
        // FOOT-GUN: RequestMethod.GET === 0, so "is this a route handler" must be an
        // undefined check. A truthiness check silently drops every GET — same trap the
        // ingest sweep guards against, carried here on purpose.
        const methodValue = Reflect.getMetadata(METHOD_METADATA, handler);
        if (methodValue === undefined) continue;
        const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        const orgRoles = (Reflect.getMetadata(ORG_ROLES_KEY, handler) ??
          Reflect.getMetadata(ORG_ROLES_KEY, ctor)) as string[] | undefined;
        routes.push({
          key: `${ctor.name}#${handlerName}`,
          method: RequestMethod[methodValue],
          guardNames: [...classGuards, ...methodGuards].map(
            (g) => (g as { name?: string }).name ?? String(g),
          ),
          isPublic:
            classIsPublic || (Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? false) === true,
          hasIngestRoute:
            (Reflect.getMetadata(INGEST_ROUTE_KEY, handler) ??
              Reflect.getMetadata(INGEST_ROUTE_KEY, ctor)) === true,
          ingestKeyAllowed:
            (Reflect.getMetadata(INGEST_KEY_ALLOWED_KEY, handler) ??
              Reflect.getMetadata(INGEST_KEY_ALLOWED_KEY, ctor)) === true,
          legalViaOrgRoles: Array.isArray(orgRoles) && orgRoles.includes('legal'),
          ctor,
          handlerName,
        });
      }
    }
  }
  return routes;
}

/** A secret key whose api_keys row LITERALLY states {"role":"legal"}. */
const explicitLegalUser = {
  authMethod: 'api-key',
  keyType: 'secret',
  organizationId: 'org-legal-sweep',
  apiKeyId: 'key_legal_sweep',
  role: 'legal',
};

function ctxFor(
  route: Pick<DiscoveredRoute, 'ctor' | 'handlerName' | 'method'>,
  user: Record<string, unknown>,
): ExecutionContext {
  return {
    getHandler: () => (route.ctor.prototype as Record<string, object>)[route.handlerName],
    getClass: () => route.ctor,
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        method: route.method,
        route: { path: `/v1/${route.handlerName}` },
      }),
    }),
  } as unknown as ExecutionContext;
}

const realGuard = () => new LegalKeyScopeGuard(new Reflector());

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('all-method route sweep', () => {
  const routes = discoverRoutes();
  const authenticated = routes.filter((r) => !r.isPublic);
  const publicRoutes = routes.filter((r) => r.isPublic);
  const legalMerit = authenticated.filter(
    (r) => r.legalViaOrgRoles || r.hasIngestRoute || r.ingestKeyAllowed,
  );
  const mustDeny = authenticated.filter(
    (r) => !r.legalViaOrgRoles && !r.hasIngestRoute && !r.ingestKeyAllowed,
  );

  // The floors below sit under the measured route counts with room for normal growth; they
  // exist to catch discovery breaking, not to pin an exact count that every new endpoint edits.
  it('discovery actually walked the controller tree, GETs included (sanity — everything below is vacuous if this breaks)', () => {
    expect(routes.length).toBeGreaterThan(180);
    expect(routes.filter((r) => r.method === 'GET').length).toBeGreaterThan(80);
    expect(routes.some((r) => r.method === 'POST')).toBe(true);
    expect(authenticated.length).toBeGreaterThan(170);
    expect(publicRoutes.length).toBeGreaterThan(0);
  });

  it("the 'legal' @OrgRoles allowlist is EXACTLY the 13 MattersController handlers — a new decorator anywhere fails CI on purpose", () => {
    const allowlisted = routes
      .filter((r) => r.legalViaOrgRoles)
      .map((r) => r.key)
      .sort();
    expect(allowlisted).toEqual([...MATTERS_LEGAL_ROLE_ALLOWLIST].sort());
  });

  it('the ingest-parity surface (the six @IngestKeyAllowed handlers + the two @IngestRoute usage POSTs) is EXACTLY the same eight handlers the ingest sweep pins', () => {
    const ingestParity = authenticated
      .filter((r) => r.hasIngestRoute || r.ingestKeyAllowed)
      .map((r) => r.key)
      .sort();
    expect(ingestParity).toEqual([...INGEST_PARITY_ALLOWLIST].sort());
  });

  it('the COMPLETE non-public surface an explicit legal key can reach is 21 handlers: the 13 Law handlers plus the 8 ingest-parity handlers', () => {
    expect(legalMerit.map((r) => r.key).sort()).toEqual(LEGAL_KEY_ALLOWLIST);
  });

  it.each(CLOSED_EXPOSURE_REPRESENTATIVES)(
    '%s (%s) — outside the Law surface and outside ingest parity, denies through the real guard for a legal key',
    (key) => {
      const route = routes.find((r) => r.key === key);
      expect(route).toBeDefined();
      expect(() => realGuard().canActivate(ctxFor(route!, explicitLegalUser))).toThrow(
        LegalKeyScopeForbiddenException,
      );
    },
  );

  it('every authenticated route outside the 21-handler surface denies an explicit legal key — every method, GETs included', () => {
    // If the deny surface ever shrinks below these floors, discovery broke — the sweep
    // must never pass by walking nothing.
    expect(mustDeny.length).toBeGreaterThan(150);
    expect(mustDeny.filter((r) => r.method === 'GET').length).toBeGreaterThan(60);
    const holes: string[] = [];
    for (const route of mustDeny) {
      try {
        realGuard().canActivate(ctxFor(route, explicitLegalUser));
        holes.push(`${route.method} ${route.key}`);
      } catch (err) {
        if (!(err instanceof LegalKeyScopeForbiddenException)) {
          holes.push(`${route.method} ${route.key} threw ${(err as Error).constructor.name}`);
        }
      }
    }
    expect(holes).toEqual([]);
  });

  it('every @Public handler passes an explicit legal key through the real guard — the defensive isPublic branch, exercised on every discovered @Public route, not only a hand-picked one', () => {
    expect(publicRoutes.length).toBeGreaterThan(0);
    const lockouts: string[] = [];
    for (const route of publicRoutes) {
      try {
        if (realGuard().canActivate(ctxFor(route, explicitLegalUser)) !== true) {
          lockouts.push(`${route.method} ${route.key} returned false`);
        }
      } catch (err) {
        lockouts.push(`${route.method} ${route.key} threw ${(err as Error).constructor.name}`);
      }
    }
    expect(lockouts).toEqual([]);
  });

  it('LegalKeyScopeGuard is mounted on zero controllers — it is global-only, so no route can opt out of it by dropping a @UseGuards', () => {
    const mounts = routes.filter((r) => r.guardNames.includes('LegalKeyScopeGuard'));
    expect(mounts.map((r) => r.key)).toEqual([]);
  });
});

describe('the 21 allowed handlers pass an EXPLICIT legal key through the REAL guard', () => {
  it.each([
    ['MattersController#getAudit', MattersController, 'getAudit', 'GET'],
    ['MattersController#getUnassigned', MattersController, 'getUnassigned', 'GET'],
    ['MattersController#assignEvent', MattersController, 'assignEvent', 'POST'],
    ['MattersController#listMatters', MattersController, 'listMatters', 'GET'],
    ['MattersController#createMatter', MattersController, 'createMatter', 'POST'],
    ['MattersController#getMatter', MattersController, 'getMatter', 'GET'],
    ['MattersController#updateMatter', MattersController, 'updateMatter', 'PATCH'],
    ['MattersController#deleteMatter', MattersController, 'deleteMatter', 'DELETE'],
    ['MattersController#listRules', MattersController, 'listRules', 'GET'],
    ['MattersController#createRule', MattersController, 'createRule', 'POST'],
    ['MattersController#applyRules', MattersController, 'applyRules', 'POST'],
    ['MattersController#updateRule', MattersController, 'updateRule', 'PATCH'],
    ['MattersController#deleteRule', MattersController, 'deleteRule', 'DELETE'],
    ['SdkPublicAliasesController#verifyApiKey', SdkPublicAliasesController, 'verifyApiKey', 'GET'],
    ['SdkPublicAliasesController#whoami', SdkPublicAliasesController, 'whoami', 'GET'],
    ['SdkController#verifyApiKey', SdkController, 'verifyApiKey', 'GET'],
    ['CostControlController#listCaps', CostControlController, 'listCaps', 'GET'],
    ['CostControlController#getSpend', CostControlController, 'getSpend', 'GET'],
    ['CostControlController#getCoverage', CostControlController, 'getCoverage', 'GET'],
    ['SdkPublicAliasesController#recordUsage', SdkPublicAliasesController, 'recordUsage', 'POST'],
    ['SdkController#recordUsage', SdkController, 'recordUsage', 'POST'],
  ] as const)('%s', (_key, ctor, handlerName, method) => {
    expect(
      realGuard().canActivate(
        ctxFor(
          {
            ctor: ctor as unknown as DiscoveredRoute['ctor'],
            handlerName,
            method,
          },
          explicitLegalUser,
        ),
      ),
    ).toBe(true);
  });

  it("every MattersController handler carries @OrgRoles including 'legal' at the method level — the allowlist above is read from the metadata, not asserted independently of it", () => {
    for (const key of MATTERS_LEGAL_ROLE_ALLOWLIST) {
      const handlerName = key.split('#')[1];
      const handler = (MattersController.prototype as unknown as Record<string, object>)[
        handlerName
      ];
      const roles = Reflect.getMetadata(ORG_ROLES_KEY, handler) as string[] | undefined;
      expect(Array.isArray(roles) && roles.includes('legal')).toBe(true);
    }
  });
});
