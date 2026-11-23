/**
 * Ship-blocking sweep: every route that reads an ORG ID OUT OF THE URL must have
 * a membership check attached to it.
 *
 * Why this file exists. A GET that binds `@Param('orgId')` and hands it to Prisma as the
 * entire authorization boundary lets any authenticated caller substitute another org's UUID
 * and read that org's customers, agents, plans, signals and subscriptions. The other sweeps
 * can't see that shape:
 *
 *   - `org-role.route-coverage.spec.ts` sweeps POST/PUT/PATCH/DELETE and deliberately skips
 *     GET (reads belong to the privileged-read catalog, not this route-coverage sweep).
 *   - `org-role.privileged-read.spec.ts` IS that catalog, but it is a hand-maintained list of
 *     named handlers. A route nobody thought to add is a route it cannot notice.
 *
 * So an unguarded org-scoped GET falls exactly between the two. This file closes that gap from
 * the other direction: instead of asking "is this route in my list", it asks the question the
 * bug is actually made of — DOES THIS HANDLER TAKE AN ORG ID FROM THE URL? Every route that
 * does, of any HTTP method, must carry `@UseGuards(OrgRoleGuard)` plus a role decorator, or be
 * named below with the mechanism that authorizes it instead.
 *
 * How it works, same machinery as the two sweeps above: walk every `*.controller.ts` ANYWHERE
 * under `src` (not just `src/modules` — a controller parked outside it would otherwise be
 * invisible to BOTH detectors), `require()` it to load the REAL classes with their REAL
 * decorators applied, and read the exact metadata
 * NestJS itself reads at request time. No app boot, no DB, no mocking of the thing under test.
 * The one extra read is `ROUTE_ARGS_METADATA`: the record Nest's own `@Param()` decorator writes,
 * which is how the framework knows to hand the handler a URL segment. Its internal shape is
 * `{ '<paramtype>:<index>': { index, data } }`, and the numeric paramtype is NOT part of Nest's
 * public API, so this file DERIVES it at runtime from a probe class instead of hardcoding it
 * (see `PATH_PARAM_PREFIX`). A Nest upgrade that renumbers the enum re-derives correctly rather
 * than silently matching nothing and going green.
 *
 * TWO DETECTORS, because either one alone has a hole you can walk through:
 *
 *   1. BINDING detector: a handler that binds `@Param('orgId'|'organizationId')`. This
 *      catches org-scoped routes wherever they live, including the
 *      ones whose CLASS path carries no org param at all (WebhooksController mounts `webhooks`
 *      and puts `:orgId` on two method paths).
 *
 *   2. CLASS-PATH detector — every handler of a controller whose `@Controller()` path mounts
 *      `:orgId`/`:organizationId`. This exists because detector 1 reads DECORATORS, and a
 *      handler can reach the same URL segment without one: `@Req() req` then `req.params.orgId`
 *      binds nothing, so detector 1 cannot see it and the route would sit unguarded behind a
 *      green sweep. So on those controllers every handler must either
 *      bind the param (and then answer to detector 1) or carry `@OrgFromUser` TOGETHER WITH
 *      OrgRoleGuard, which is a written statement that it authorizes the CALLER'S own org and
 *      ignores the URL. The guard is not optional in that pairing: `@OrgFromUser` is inert
 *      metadata that only OrgRoleGuard.canActivate ever reads, so the decorator by itself
 *      enforces nothing.
 *      InvoiceCalculatorController's three handlers are the only ones that take that route.
 *
 * WHAT IS NOT COVERED, stated so it is a decision and not an oversight:
 *
 *   - The param NAMES are `orgId` and `organizationId`. Not `:id`. The only controller where
 *     `:id` means an org is OrganizationsController, whose three write routes are already
 *     covered (with their exemptions reasoned out) by `org-role.route-coverage.spec.ts`, and
 *     whose `GET :id` already carries the guard; everywhere else `:id` is an agent, a plan, a
 *     signal, an invoice. Widening this sweep to `:id` would mostly restate that file's
 *     allowlist. If a SECOND controller ever names an org param `:id`, add the name here.
 *   - A consequence of that name limit: `OrganizationsController#switchOrganization` is OUTSIDE this sweep.
 *     `GET :id/switch` (organizations.controller.ts) carries an org id in `:id`, carries no
 *     OrgRoleGuard, and is authorized by a hand-rolled membership lookup in the service
 *     (organizations.service.ts). That lookup reads `ba_member`, the same table OrgRoleGuard
 *     reads, and `membership.sweep.spec.ts` fails the build if a new path writes one
 *     membership table on its own. Its authorization is hand-rolled, so read it before
 *     you copy it.
 *   - Handlers whose METHOD path carries `:orgId` on a controller whose CLASS path does not.
 *     That is a large family — invoices, agents, signals, pricing-plans, subscriptions,
 *     analytics, customers, signal-events, service-pricing all declare
 *     `@Get(['invoices', 'org/:orgId/invoices'])`-style dual paths. They are safe STRUCTURALLY,
 *     not because a sweep watches them: `org/:orgId/...` there is a URL alias the handler
 *     binds nothing from and the service ignores, because these scope on `user.organizationId`
 *     (InvoicesController#createInvoice is the canonical shape, and OrgRoleGuard's `@OrgFromUser`
 *     docstring explains why the guard must judge the caller's org on them). Detector 1 does not
 *     see them because they bind nothing; detector 2 does not because their class path is bare.
 *     What would slip past both is one of THOSE handlers starting to read the alias off
 *     `@Req() req.params.orgId`. Catching that needs handler-body analysis, which this file
 *     does not do. The two webhook receivers are the exception in that family: they do bind
 *     `@Param('orgId')` from their method path, so detector 1 has them.
 */

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Param, Query, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';

const SRC_ROOT = path.join(__dirname, '..', '..');
const IS_PUBLIC_KEY = 'isPublic';
const ORG_ROLES_KEY = 'orgRoles';
const ORG_FROM_USER_KEY = 'orgFromUser';
const HUMAN_ONLY_KEY = 'humanOnly';

/** URL param names that mean "the organization being acted on". See the scope limit above. */
const ORG_ID_PARAM_NAMES = new Set(['orgId', 'organizationId']);

/**
 * A throwaway class whose only job is to let Nest's own decorators tell us which numeric
 * paramtype means "path param". Both methods below use the SAME data string on purpose: the
 * path-vs-query answer has to come from the paramtype, never from the name.
 */
class ParamtypeProbe {
  pathAndQuery(@Param('orgId') fromPath: string, @Query('orgId') fromQuery: string) {
    return `${fromPath}${fromQuery}`;
  }

  entityIdOnly(@Param('id') id: string) {
    return id;
  }
}

type RouteArgs = Record<string, { index: number; data?: unknown }>;

/**
 * Nest records every `@Param()`/`@Query()` binding of a handler in ONE metadata entry on the
 * CONTROLLER CLASS (not the prototype), shaped `{ '<paramtype>:<index>': { index, data } }`.
 * Neither the metadata key nor the numeric paramtype is part of Nest's public API, so both are
 * DERIVED from the probe class above rather than hardcoded. A Nest upgrade that renames the key
 * or renumbers the enum then re-derives correctly, instead of the sweep silently matching
 * nothing and passing vacuously forever, which is the worst thing a security test can do.
 */
const ROUTE_ARGS_KEY: string = (() => {
  for (const key of Reflect.getMetadataKeys(ParamtypeProbe, 'pathAndQuery')) {
    const value = Reflect.getMetadata(key, ParamtypeProbe, 'pathAndQuery');
    if (value && typeof value === 'object') {
      const bindings = Object.values(value as RouteArgs);
      if (bindings.some((binding) => binding?.data === 'orgId')) return String(key);
    }
  }
  throw new Error(
    "Could not find the metadata that Nest's @Param() writes for a controller method. Nest " +
      'changed how it records route arguments; re-derive this sweep before trusting it again.',
  );
})();

function routeArgsOf(ctor: unknown, handlerName: string): RouteArgs {
  return (Reflect.getMetadata(ROUTE_ARGS_KEY, ctor as object, handlerName) ?? {}) as RouteArgs;
}

/** The `<paramtype>` half of that key for a PATH param, likewise derived and not guessed. */
const PATH_PARAM_PREFIX = (() => {
  const args = routeArgsOf(ParamtypeProbe, 'pathAndQuery');
  const entry = Object.entries(args).find(([, meta]) => meta.index === 0);
  if (!entry) {
    throw new Error(
      'Could not read @Param() metadata off the probe class. Nest changed how it records ' +
        'route arguments; this sweep must be re-derived before it can be trusted again.',
    );
  }
  return entry[0].split(':')[0];
})();

const QUERY_PARAM_PREFIX = (() => {
  const args = routeArgsOf(ParamtypeProbe, 'pathAndQuery');
  const entry = Object.entries(args).find(([, meta]) => meta.index === 1);
  return entry ? entry[0].split(':')[0] : undefined;
})();

/** The org-id URL params a handler binds. Empty means it takes no org id from the URL. */
function orgIdPathParams(ctor: unknown, handlerName: string): string[] {
  return Object.entries(routeArgsOf(ctor, handlerName))
    .filter(([key]) => key.split(':')[0] === PATH_PARAM_PREFIX)
    .map(([, meta]) => meta.data)
    .filter((data): data is string => typeof data === 'string' && ORG_ID_PARAM_NAMES.has(data));
}

/**
 * Detector 2 (see the header): does this controller's own `@Controller()` path mount an org
 * param, so that EVERY handler under it receives one whether or not it binds it? The value can
 * be a string or an array of strings, and a segment may carry Nest's optional/regex suffixes,
 * so compare on the bare param name rather than on the whole path.
 */
function classPathMountsOrgId(classPath: unknown): boolean {
  const paths: unknown[] = Array.isArray(classPath) ? classPath : [classPath];
  return paths.some(
    (p) =>
      typeof p === 'string' &&
      p
        .split('/')
        .filter((segment) => segment.startsWith(':'))
        .some((segment) => ORG_ID_PARAM_NAMES.has(segment.slice(1).split(/[?(]/)[0])),
  );
}

interface DiscoveredRoute {
  key: string; // "ControllerName#handlerName" — the identity every allowlist below uses
  file: string;
  httpMethod: string;
  boundOrgParams: string[];
  orgIdInClassPath: boolean;
  guardNames: string[];
  hasRoleDecorator: boolean;
  hasOrgFromUser: boolean;
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

function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const file of findControllerFiles(SRC_ROOT)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- loads each controller file found on disk
    const mod = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctor = exported as new (...args: unknown[]) => unknown;
      const classPath: unknown = Reflect.getMetadata(PATH_METADATA, ctor);
      if (classPath === undefined) continue; // not a @Controller
      const orgIdInClassPath = classPathMountsOrgId(classPath);
      const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctor) ?? [];
      const classIsPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctor) ?? false;
      const proto = ctor.prototype;
      for (const handlerName of Object.getOwnPropertyNames(proto)) {
        if (handlerName === 'constructor') continue;
        const handler = proto[handlerName];
        if (typeof handler !== 'function') continue;
        // FOOT-GUN (inherited from publishable-key.route-sweep.spec.ts): RequestMethod.GET is 0,
        // so "is this a route handler" must be an undefined check. A truthiness check drops
        // every GET — which is the entire class of route this sweep exists for.
        const methodValue = Reflect.getMetadata(METHOD_METADATA, handler);
        if (methodValue === undefined) continue;
        const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        routes.push({
          key: `${ctor.name}#${handlerName}`,
          file: path.relative(SRC_ROOT, file),
          httpMethod: RequestMethod[methodValue],
          boundOrgParams: orgIdPathParams(ctor, handlerName),
          orgIdInClassPath,
          guardNames: [...classGuards, ...methodGuards].map(
            (g) => (g as { name?: string }).name ?? String(g),
          ),
          // getAllAndOverride semantics: method-level wins, else class-level.
          hasRoleDecorator:
            Reflect.getMetadata(ORG_ROLES_KEY, handler) !== undefined ||
            Reflect.getMetadata(ORG_ROLES_KEY, ctor) !== undefined ||
            (Reflect.getMetadata(HUMAN_ONLY_KEY, handler) ??
              Reflect.getMetadata(HUMAN_ONLY_KEY, ctor)) === true,
          hasOrgFromUser:
            (Reflect.getMetadata(ORG_FROM_USER_KEY, handler) ??
              Reflect.getMetadata(ORG_FROM_USER_KEY, ctor)) === true,
          isPublic:
            classIsPublic || (Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? false) === true,
        });
      }
    }
  }
  return routes;
}

/**
 * @Public routes that bind an org id. Exempt because there is no authenticated caller to check
 * membership for, and the org id is not a data scope: the webhook receiver uses it only to pick
 * WHICH provider record's secret verifies the inbound HMAC, so a wrong org id fails signature
 * verification instead of granting anything.
 *
 * Verified against the handler, not assumed. Adding to this set is a security decision.
 */
const PUBLIC_SELF_AUTHENTICATING = new Set(['WebhooksController#handleStripeWebhookForOrg']);

function isExempt(route: DiscoveredRoute): boolean {
  if (route.isPublic && PUBLIC_SELF_AUTHENTICATING.has(route.key)) return true;
  return false;
}

describe('org-id-from-the-URL sweep — the detector itself is honest', () => {
  it('derives the path-param metadata key from Nest rather than hardcoding it', () => {
    expect(PATH_PARAM_PREFIX).toMatch(/^\d+$/);
  });

  it('tells a path param apart from a query param carrying the identical name', () => {
    // If these ever collapse, the sweep would start flagging `?orgId=` query bindings and,
    // worse, could match nothing at all and pass vacuously forever.
    expect(QUERY_PARAM_PREFIX).toBeDefined();
    expect(QUERY_PARAM_PREFIX).not.toBe(PATH_PARAM_PREFIX);
    expect(orgIdPathParams(ParamtypeProbe, 'pathAndQuery')).toEqual(['orgId']);
  });

  it('does not flag a handler that binds a non-org path param', () => {
    expect(orgIdPathParams(ParamtypeProbe, 'entityIdOnly')).toEqual([]);
  });

  it('reads an org param out of a controller class path, in every shape Nest allows', () => {
    expect(classPathMountsOrgId('org/:orgId/filters')).toBe(true);
    expect(classPathMountsOrgId('org/:organizationId/filters')).toBe(true);
    expect(classPathMountsOrgId(['health', 'org/:orgId/filters'])).toBe(true);
    expect(classPathMountsOrgId('org/:orgId?/filters')).toBe(true);
  });

  it('walks controllers that live outside src/modules, which is what the header claims', () => {
    // Walking only `src/modules` plus a HARDCODED `src/app.controller.ts` would leave a
    // controller parked anywhere else invisible to both detectors. Falsifiable on purpose: narrowing the root back to `modules` empties the difference set.
    // `toContain` rather than `toEqual` so a legitimately-new outside controller joins the
    // per-handler assertions below instead of turning this file red over a list.
    const all = findControllerFiles(SRC_ROOT).map((f) => path.relative(SRC_ROOT, f));
    const inModules = findControllerFiles(path.join(SRC_ROOT, 'modules')).map((f) =>
      path.relative(SRC_ROOT, f),
    );
    expect(all.filter((f) => !inModules.includes(f))).toContain('app.controller.ts');
  });

  it('does not mistake a look-alike class path for an org-scoped one', () => {
    // `:orgIdentifier` is a different param; `webhooks` is the real shape that must stay OUT of
    // detector 2 (its org segment is on the METHOD path, and detector 1 owns it).
    expect(classPathMountsOrgId('webhooks')).toBe(false);
    expect(classPathMountsOrgId('org/:orgIdentifier/filters')).toBe(false);
    expect(classPathMountsOrgId('invitations')).toBe(false);
    expect(classPathMountsOrgId('/')).toBe(false);
  });
});

describe('org-id-from-the-URL sweep — every such route has a membership check', () => {
  const routes = discoverRoutes();
  const orgIdRoutes = routes.filter((r) => r.boundOrgParams.length > 0);

  it('discovery actually walked the controller tree (everything below is vacuous if this breaks)', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.some((r) => r.httpMethod === 'GET')).toBe(true);
    expect(routes.some((r) => r.httpMethod === 'POST')).toBe(true);
  });

  it('found the org-id-binding routes, and they are a strict subset of all routes', () => {
    // These live across api-keys, filters, payment-providers, stripe-connect,
    // team and webhooks. The floor catches a detector that silently stops matching;
    // the subset check catches one that starts matching everything.
    expect(orgIdRoutes.length).toBeGreaterThan(20);
    expect(orgIdRoutes.length).toBeLessThan(routes.length);
  });

  it('the filters route is under the sweep (GET /v1/org/:orgId/filters)', () => {
    const filters = orgIdRoutes.find((r) => r.key === 'FiltersController#getFilters');
    expect(filters).toBeDefined();
    expect(filters?.httpMethod).toBe('GET');
    expect(filters?.guardNames).toContain('OrgRoleGuard');
  });

  const subjectToSweep = orgIdRoutes.filter((r) => !isExempt(r));

  it('at least one route is actually subject to the sweep (not everything got exempted)', () => {
    expect(subjectToSweep.length).toBeGreaterThan(20);
  });

  it.each(subjectToSweep.map((r) => [`${r.httpMethod} ${r.key}`, r] as const))(
    '%s takes an org id from the URL, so it carries OrgRoleGuard + a role decorator',
    (_label, route) => {
      expect(route.guardNames).toContain('OrgRoleGuard');
      expect(route.hasRoleDecorator).toBe(true);
    },
  );

  it.each(subjectToSweep.map((r) => [`${r.httpMethod} ${r.key}`, r] as const))(
    '%s does not also carry @OrgFromUser, which would authorize a different org than it reads',
    (_label, route) => {
      // @OrgFromUser makes the guard check the CALLER'S OWN org and ignore the URL. On a handler
      // that then reads the URL org, the guard would clear org B while the handler served org A.
      // The decorator's own docstring warns against exactly this pairing (OrgFromUser in
      // org-role.guard.ts, "Do NOT put this on the api-keys/stripe/organizations routes"), but a warning in a
      // comment is not a lock. Nothing but this assertion stops a route from doing it.
      expect(route.hasOrgFromUser).toBe(false);
    },
  );
});

/**
 * The six controllers that mount an org param in their `@Controller()` path. Asserted as
 * a floor (arrayContaining), not an exact list: a NEW org-scoped controller should simply join
 * the per-handler assertion below, not turn this file red with a message about a list. The floor
 * is here so that a detector which quietly stops matching cannot pass vacuously.
 */
const KNOWN_ORG_CLASS_PATH_CONTROLLERS = [
  'ApiKeysController',
  'FiltersController',
  'InvoiceCalculatorController',
  'PaymentProvidersController',
  'StripeConnectController',
  'TeamController',
];

describe('org-id-from-the-URL sweep — the @Req() blind spot in detector 1', () => {
  const routes = discoverRoutes();
  const classPathRoutes = routes.filter((r) => r.orgIdInClassPath);

  it('found the controllers that mount :orgId in their class path', () => {
    const controllers = [...new Set(classPathRoutes.map((r) => r.key.split('#')[0]))];
    expect(controllers).toEqual(expect.arrayContaining(KNOWN_ORG_CLASS_PATH_CONTROLLERS));
  });

  it('every one of their handlers is visible to one detector or the other', () => {
    // The summary form of the per-handler assertion, kept because it is the sentence the file
    // is actually claiming: on an org-mounted controller there is no third option.
    // The @OrgFromUser half requires the guard too, for the reason spelled out on the
    // per-handler assertion below: the decorator is inert metadata unless OrgRoleGuard reads it.
    const invisible = classPathRoutes.filter(
      (r) =>
        r.boundOrgParams.length === 0 &&
        !(r.hasOrgFromUser && r.guardNames.includes('OrgRoleGuard')),
    );
    expect(invisible.map((r) => r.key)).toEqual([]);
  });

  it.each(classPathRoutes.map((r) => [`${r.httpMethod} ${r.key}`, r] as const))(
    '%s is mounted under a :orgId class path, so it binds that param or declares @OrgFromUser + OrgRoleGuard',
    (_label, route) => {
      // Binding it hands the handler to detector 1 and the guard assertions above. Declaring
      // @OrgFromUser is the written alternative: the guard then judges the CALLER'S own org and
      // the handler must not read the URL one. A handler that does NEITHER still receives the
      // URL segment and can read it off `@Req() req.params.orgId` with nothing in CI watching,
      // which is the hole this block exists to close.
      expect(route.boundOrgParams.length > 0 || route.hasOrgFromUser).toBe(true);

      // ...but @OrgFromUser ALONE is not an alternative, because on its own it is inert
      // metadata. Nothing in the app reads ORG_FROM_USER_KEY except OrgRoleGuard.canActivate
      // (in org-role.guard.ts, the sole consumer). Accepting the bare decorator would let a
      // handler on an org-mounted controller carry it, carry NO guard, and pass this sweep while
      // enforcing nothing at all. The handlers that use it here (invoice-calculator.controller.ts)
      // pair it with the guard; this is what holds that.
      if (route.hasOrgFromUser) {
        expect(route.guardNames).toContain('OrgRoleGuard');
      }
    },
  );
});

describe('org-id-from-the-URL sweep — the exemptions are checked, not trusted', () => {
  const routes = discoverRoutes();

  it.each([...PUBLIC_SELF_AUTHENTICATING])(
    '%s is still @Public — if it ever becomes authenticated it rejoins the sweep',
    (key) => {
      const route = routes.find((r) => r.key === key);
      expect(route).toBeDefined();
      expect(route?.isPublic).toBe(true);
    },
  );
});
