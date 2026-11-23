/**
 * The route-sweep CI lock for the publishable-key boundary, in the deny-by-default shape.
 *
 * An undecorated new route is the SAFE state (denied), so it must NOT fail CI. What must
 * never grow silently is the ALLOWLIST. The machinery: walk every controller file, load
 * the REAL classes, read the SAME metadata Nest reads at request time, drive the REAL
 * guard. No app boot, no DB.
 *
 * What this file locks:
 *   1. The @PublishableKeyAllowed set is EXACTLY the three key-identity routes.
 *      A new decorator anywhere fails CI on purpose.
 *   2. Every other authenticated route — every method, including role-gated routes —
 *      denies a publishable key through the real guard. Role gates are deliberately NOT
 *      excluded: a publishable key is minted role 'member' and bare @OrgRoles() means
 *      "any member (read-level)", so member-floor GETs (the team roster with teammate
 *      emails, the org read) would be publishable-readable otherwise. classify() buckets
 *      them ORG_ROLE_GATED; do not filter them out here.
 *   3. The three key-identity routes still pass a publishable key (metadata AND behavior) —
 *      the code-cost-clarity installer and auth-hold recovery depend on those 200s.
 *   4. The ingest POSTs carry @IngestRoute, no allowlist decorator, and the real guard
 *      passes a publishable key — the pk ingest 403 stays with the write interceptor,
 *      whose exception class is what pages the alerts channel.
 *   5. PublishableKeyGuard has zero controller mounts, so no publishable-key consumer
 *      depends on a route-scoped mount.
 */

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionContext, Logger, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { PublishableKeyReadGuard, PUBLISHABLE_KEY_ALLOWED_KEY } from './publishable-key-read.guard';
import { PublishableKeyReadForbiddenException } from '../exceptions/publishable-key-read-forbidden.exception';
import { INGEST_ROUTE_KEY } from './route-metadata-keys';
import { SdkPublicAliasesController } from '../../modules/sdk/sdk-public-aliases.controller';
import { SdkController } from '../../modules/sdk/sdk.controller';

const SRC_ROOT = path.join(__dirname, '..', '..');
const IS_PUBLIC_KEY = 'isPublic';

/**
 * The whole allowlist. Growing it is a product decision about what an embeddable
 * browser-safe credential may see, never a convenience — see the @PublishableKeyAllowed
 * docstring for what these three expose and who depends on them.
 */
const PUBLISHABLE_KEY_ALLOWLIST = [
  'SdkController#verifyApiKey',
  'SdkPublicAliasesController#verifyApiKey',
  'SdkPublicAliasesController#whoami',
];

/**
 * Named representatives of the exposure the boundary closes: the customer roster, the
 * invoice list, MRR. Pinned by name so the diff that re-opens any of them has to delete
 * a line that says what it is re-opening. The behavioral sweep below covers every route
 * plus all writes.
 */
const CLOSED_EXPOSURE_REPRESENTATIVES = [
  ['CustomersController#getCustomers', 'the full customer roster'],
  ['InvoicesController#getInvoices', 'every invoice'],
  ['AnalyticsController#getMrr', 'MRR'],
] as const;

interface DiscoveredRoute {
  key: string;
  method: string;
  guardNames: string[];
  isPublic: boolean;
  hasIngestRoute: boolean;
  publishableKeyAllowed: boolean;
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
        // undefined check. A truthiness check silently drops every GET (including the
        // reads the boundary closes) and the sweep goes green proving nothing.
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
          publishableKeyAllowed:
            (Reflect.getMetadata(PUBLISHABLE_KEY_ALLOWED_KEY, handler) ??
              Reflect.getMetadata(PUBLISHABLE_KEY_ALLOWED_KEY, ctor)) === true,
          ctor,
          handlerName,
        });
      }
    }
  }
  return routes;
}

function pkCtx(route: Pick<DiscoveredRoute, 'ctor' | 'handlerName' | 'method'>): ExecutionContext {
  return {
    getHandler: () => (route.ctor.prototype as Record<string, object>)[route.handlerName],
    getClass: () => route.ctor,
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          authMethod: 'api-key',
          keyType: 'publishable',
          organizationId: 'org-publishable-sweep',
          apiKeyId: 'key_publishable_sweep',
          role: 'member',
        },
        method: route.method,
        route: { path: `/v1/${route.handlerName}` },
      }),
    }),
  } as unknown as ExecutionContext;
}

const realGuard = () => new PublishableKeyReadGuard(new Reflector());

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('all-method route sweep', () => {
  const routes = discoverRoutes();

  it('discovery actually walked the controller tree (sanity — everything below is vacuous if this breaks)', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.some((r) => r.method === 'GET')).toBe(true);
    expect(routes.some((r) => r.method === 'POST')).toBe(true);
  });

  it('the publishable-key allowlist is EXACTLY three routes — a new @PublishableKeyAllowed anywhere fails CI on purpose', () => {
    const allowlisted = routes
      .filter((r) => r.publishableKeyAllowed)
      .map((r) => r.key)
      .sort();
    expect(allowlisted).toEqual(PUBLISHABLE_KEY_ALLOWLIST);
  });

  it.each(CLOSED_EXPOSURE_REPRESENTATIVES)(
    '%s (%s) denies a publishable key through the real guard',
    (key) => {
      const route = routes.find((r) => r.key === key);
      expect(route).toBeDefined();
      expect(() => realGuard().canActivate(pkCtx(route!))).toThrow(
        PublishableKeyReadForbiddenException,
      );
    },
  );

  it('every authenticated route that is not public, not ingest, and not allowlisted denies a publishable key — every method, role-gated routes included', () => {
    const mustDeny = routes.filter(
      (r) => !r.isPublic && !r.hasIngestRoute && !r.publishableKeyAllowed,
    );
    // If the deny surface ever shrinks below this floor, discovery broke — the sweep
    // must never pass by walking nothing.
    expect(mustDeny.length).toBeGreaterThan(140);
    const holes: string[] = [];
    for (const route of mustDeny) {
      try {
        realGuard().canActivate(pkCtx(route));
        holes.push(`${route.method} ${route.key}`);
      } catch (err) {
        if (!(err instanceof PublishableKeyReadForbiddenException)) {
          holes.push(`${route.method} ${route.key} threw ${(err as Error).constructor.name}`);
        }
      }
    }
    expect(holes).toEqual([]);
  });

  it('PublishableKeyGuard is mounted on zero controllers — so no publishable-key consumer depends on a route-scoped mount', () => {
    const mounts = routes.filter((r) => r.guardNames.includes('PublishableKeyGuard'));
    expect(mounts.map((r) => r.key)).toEqual([]);
  });
});

describe('the contract routes stay publishable-key readable — the code-cost-clarity installer, its auth-hold recovery, and sdk connect()/verify() depend on their 200s', () => {
  it.each([
    ['SdkPublicAliasesController#verifyApiKey', SdkPublicAliasesController, 'verifyApiKey'],
    ['SdkPublicAliasesController#whoami', SdkPublicAliasesController, 'whoami'],
    ['SdkController#verifyApiKey', SdkController, 'verifyApiKey'],
  ] as const)('%s passes a publishable key through the REAL guard', (_key, ctor, handlerName) => {
    const guard = realGuard();
    expect(
      guard.canActivate(
        pkCtx({
          ctor: ctor as unknown as DiscoveredRoute['ctor'],
          handlerName,
          method: 'GET',
        }),
      ),
    ).toBe(true);
  });
});

describe('ingest is untouched', () => {
  it.each([
    ['SdkPublicAliasesController#recordUsage', SdkPublicAliasesController],
    ['SdkController#recordUsage', SdkController],
  ] as const)(
    '%s carries @IngestRoute, no allowlist decorator, and the REAL guard passes a publishable key — its 403 stays with the write interceptor that pages the alerts channel',
    (_key, ctor) => {
      const handler = (ctor.prototype as unknown as Record<string, object>)['recordUsage'];
      expect(Reflect.getMetadata(INGEST_ROUTE_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata(PUBLISHABLE_KEY_ALLOWED_KEY, handler)).toBeUndefined();
      const guard = realGuard();
      expect(
        guard.canActivate(
          pkCtx({
            ctor: ctor as unknown as DiscoveredRoute['ctor'],
            handlerName: 'recordUsage',
            method: 'POST',
          }),
        ),
      ).toBe(true);
    },
  );
});
