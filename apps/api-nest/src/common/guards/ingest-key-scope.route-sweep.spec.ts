/**
 * The route-sweep CI lock for the ingest-role boundary, in the deny-by-default shape.
 *
 * The shape matters more than the assertions. A hand-listed ledger of routes an
 * under-privileged key could reach, where a NEW ungated route fails CI, is the wrong
 * shape under deny-by-default: an undecorated new route is the SAFE state, so failing
 * every new endpoint red trains people to edit the spec instead of reading it. So:
 *
 *   undecorated == DENIED == SAFE == CI GREEN.
 *
 * What fails CI here is a NEW @IngestKeyAllowed. Growing the allowlist is a product
 * decision about what a send-usage-only credential may read, never a convenience.
 *
 * Same machinery as the publishable sweep: walk every controller file, load the REAL
 * classes, read the SAME metadata Nest reads at request time, drive the REAL guard. No
 * app boot, no DB. The route-count floors below are re-derived from THIS sweep's own
 * discovery — the publishable sweep's numbers describe a different must-deny set (it
 * excludes @IngestRoute from denial; this one allows it) and copying them would pin the
 * wrong thing.
 *
 * What this file locks:
 *   1. The @IngestKeyAllowed set is EXACTLY the six handlers listed in ingest-key-scope.guard.ts.
 *   2. The complete surface an explicit ingest key can reach is those six plus the two
 *      @IngestRoute usage POSTs. Eight handlers, nothing else, every method.
 *   3. Every other authenticated route denies through the real guard, GETs included.
 *      RequestMethod.GET === 0, and a truthiness check on METHOD_METADATA in a
 *      discovery loop silently drops every GET, so discovery asserts GETs were found.
 */

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionContext, Logger, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { IngestKeyScopeGuard, INGEST_KEY_ALLOWED_KEY } from './ingest-key-scope.guard';
import { IngestKeyScopeForbiddenException } from '../exceptions/ingest-key-scope-forbidden.exception';
import { INGEST_ROUTE_KEY } from './route-metadata-keys';
import { SdkPublicAliasesController } from '../../modules/sdk/sdk-public-aliases.controller';
import { SdkController } from '../../modules/sdk/sdk.controller';
import { CostControlController } from '../../modules/cost-control/cost-control.controller';

const SRC_ROOT = path.join(__dirname, '..', '..');
const IS_PUBLIC_KEY = 'isPublic';

/**
 * The whole @IngestKeyAllowed allowlist. Keyed on the handler, never on
 * a path string: two of these are DUPLICATE handlers on two different controllers (the
 * canonical /v1/verify and the alias /v1/sdk/verify), so a path-keyed allowlist would
 * quietly cover one door and miss the other.
 */
const INGEST_KEY_ALLOWLIST = [
  'CostControlController#getCoverage',
  'CostControlController#getSpend',
  'CostControlController#listCaps',
  'SdkController#verifyApiKey',
  'SdkPublicAliasesController#verifyApiKey',
  'SdkPublicAliasesController#whoami',
];

/** The two usage-record POSTs, allowed via their existing @IngestRoute metadata. */
const INGEST_ROUTE_HANDLERS = [
  'SdkController#recordUsage',
  'SdkPublicAliasesController#recordUsage',
];

/**
 * Named representatives of what an ingest key could reach without this guard. Pinned by
 * name so the diff that re-opens any of them has to delete a line saying what it is
 * re-opening. The behavioral sweep below covers every authenticated route and stays
 * correct on its own as routes come and go.
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
        // undefined check. A truthiness check silently drops every GET, and the GETs are
        // the sensitive reads (MRR, invoices, the customer roster). The org-role
        // route-coverage spec filters to POST/PUT/PATCH/DELETE, so it can't catch this.
        const methodValue = Reflect.getMetadata(METHOD_METADATA, handler);
        if (methodValue === undefined) continue;
        const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
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
          ctor,
          handlerName,
        });
      }
    }
  }
  return routes;
}

/** A secret key whose api_keys row LITERALLY states {"role":"ingest"}. */
const explicitIngestUser = {
  authMethod: 'api-key',
  keyType: 'secret',
  organizationId: 'org-ingest-sweep',
  apiKeyId: 'key_ingest_sweep',
  role: 'ingest',
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

const realGuard = () => new IngestKeyScopeGuard(new Reflector());

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('all-method route sweep', () => {
  const routes = discoverRoutes();
  const authenticated = routes.filter((r) => !r.isPublic);
  const reachable = authenticated.filter((r) => r.hasIngestRoute || r.ingestKeyAllowed);
  const mustDeny = authenticated.filter((r) => !r.hasIngestRoute && !r.ingestKeyAllowed);

  // The floors below sit under the current route counts with room for normal growth; they
  // exist to catch discovery breaking, not to pin an exact count that every new endpoint
  // edits.
  it('discovery actually walked the controller tree, GETs included (sanity — everything below is vacuous if this breaks)', () => {
    expect(routes.length).toBeGreaterThan(180);
    expect(routes.filter((r) => r.method === 'GET').length).toBeGreaterThan(80);
    expect(routes.some((r) => r.method === 'POST')).toBe(true);
    expect(authenticated.length).toBeGreaterThan(160);
  });

  it('the @IngestKeyAllowed allowlist is EXACTLY the six listed handlers — a new decorator anywhere fails CI on purpose', () => {
    const allowlisted = routes
      .filter((r) => r.ingestKeyAllowed)
      .map((r) => r.key)
      .sort();
    expect(allowlisted).toEqual(INGEST_KEY_ALLOWLIST);
  });

  it('the COMPLETE surface an explicit ingest key can reach is eight handlers: the six allowlisted plus the two @IngestRoute usage POSTs', () => {
    expect(reachable.map((r) => r.key).sort()).toEqual(
      [...INGEST_KEY_ALLOWLIST, ...INGEST_ROUTE_HANDLERS].sort(),
    );
  });

  it.each(CLOSED_EXPOSURE_REPRESENTATIVES)(
    '%s (%s) denies an ingest key through the real guard',
    (key) => {
      const route = routes.find((r) => r.key === key);
      expect(route).toBeDefined();
      expect(() => realGuard().canActivate(ctxFor(route!, explicitIngestUser))).toThrow(
        IngestKeyScopeForbiddenException,
      );
    },
  );

  it('every authenticated route outside the eight-handler surface denies an explicit ingest key — every method, GETs included', () => {
    // If the deny surface ever shrinks below these floors, discovery broke — the sweep
    // must never pass by walking nothing. Derived from THIS sweep's own count, not
    // copied from the publishable sweep, whose must-deny set is a different set: it
    // denies @IngestRoute and this one allows it. The GET floor is separate on purpose,
    // because a discovery loop that drops GETs still leaves plenty of writes to deny
    // and would otherwise pass looking healthy.
    expect(mustDeny.length).toBeGreaterThan(150);
    expect(mustDeny.filter((r) => r.method === 'GET').length).toBeGreaterThan(60);
    const holes: string[] = [];
    for (const route of mustDeny) {
      try {
        realGuard().canActivate(ctxFor(route, explicitIngestUser));
        holes.push(`${route.method} ${route.key}`);
      } catch (err) {
        if (!(err instanceof IngestKeyScopeForbiddenException)) {
          holes.push(`${route.method} ${route.key} threw ${(err as Error).constructor.name}`);
        }
      }
    }
    expect(holes).toEqual([]);
  });

  it('IngestKeyScopeGuard is mounted on zero controllers — it is global-only, so no route can opt out of it by dropping a @UseGuards', () => {
    const mounts = routes.filter((r) => r.guardNames.includes('IngestKeyScopeGuard'));
    expect(mounts.map((r) => r.key)).toEqual([]);
  });
});

describe('the eight allowed handlers pass an EXPLICIT ingest key through the REAL guard', () => {
  it.each([
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
          explicitIngestUser,
        ),
      ),
    ).toBe(true);
  });

  it('the two usage POSTs carry @IngestRoute and NO @IngestKeyAllowed — the ingest path is honored through the marker every other guard already reads on it, not a second decorator that could drift', () => {
    for (const ctor of [SdkPublicAliasesController, SdkController]) {
      const handler = (ctor.prototype as unknown as Record<string, object>)['recordUsage'];
      expect(Reflect.getMetadata(INGEST_ROUTE_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata(INGEST_KEY_ALLOWED_KEY, handler)).toBeUndefined();
    }
  });

  it("GET /v1/me/key is allowlisted — code-cost-clarity's auth-hold recovery probes it every 5 minutes and a 403 wedges the hold permanently, parking the customer's usage on disk with no alarm", () => {
    const handler = (SdkPublicAliasesController.prototype as unknown as Record<string, object>)[
      'whoami'
    ];
    expect(Reflect.getMetadata(INGEST_KEY_ALLOWED_KEY, handler)).toBe(true);
  });

  it('both verify doors are allowlisted, not only the canonical one — they are pinned as behaviourally identical and an SDK build in the field may hit either', () => {
    for (const ctor of [SdkPublicAliasesController, SdkController]) {
      const handler = (ctor.prototype as unknown as Record<string, object>)['verifyApiKey'];
      expect(Reflect.getMetadata(INGEST_KEY_ALLOWED_KEY, handler)).toBe(true);
    }
  });
});
