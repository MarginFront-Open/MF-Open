/**
 * Revoking a secret key must kill every portal magic link and portal
 * session for the org, on the next request.
 *
 * What this proves, end to end: the REAL ApiKeysController -> REAL ApiKeysService
 * revoke path expires the org's live portal rows, and the REAL validators —
 * AuthService.validatePortalSessionToken and PortalSessionGuard.canActivate, the
 * exact code the PATCH /portal/profile pipeline runs — refuse those rows
 * afterwards. Prisma is stubbed only at the I/O boundary with an in-memory store.
 *
 * WHY THE STORE IMPLEMENTS {gt: Date} OPERATOR SEMANTICS: the cascade writes
 * expiresAt into the past and every reader filters expiresAt: { gt: now }. A
 * scalar-equality matcher cannot express that filter — it would force dropping
 * expiresAt from the comparison, at which point every cascade test here goes
 * vacuously green while ignoring the one field the cascade writes.
 *
 * MUTATION CONTROL: the pre-revoke negative control proves each session
 * validates BEFORE the revoke, so "validates -> revoke -> refused" cannot pass
 * vacuously. Disable the cascade inside ApiKeysService.revokeApiKey and the
 * "kills the session" / "kills the magic link" tests go red.
 */

import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hashApiKeyForLookup } from '@marginfront/db';

import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { AuthService } from '../auth/auth.service';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';
import { PortalSessionGuard } from '../../common/guards/portal-session.guard';
import { PortalSessionsService } from '../portal-sessions/portal-sessions.service';

const ORG_A = 'org-aaaa-1111';
const ORG_B = 'org-bbbb-2222';
const SECRET_KEY_A = 'key-secret-a';
const PUB_KEY_A = 'key-pub-a';
const CUST_A = 'cust-a';
const CUST_B = 'cust-b';
const RAW_SESSION_A = 'prtl_live_session_org_a';
const RAW_SESSION_B = 'prtl_live_session_org_b';

const HOUR_MS = 60 * 60 * 1000;

type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// In-memory Prisma stand-in with {gt}/{lt} operator semantics and a
// snapshot-restoring $transaction (a thrown callback rolls every write back,
// like the real thing).
// ---------------------------------------------------------------------------

function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    if (
      cond !== null &&
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      !Array.isArray(cond)
    ) {
      return Object.entries(cond as Record<string, unknown>).every(([op, value]) => {
        const current = row[field] as Date;
        if (op === 'gt') return current > (value as Date);
        if (op === 'lt') return current < (value as Date);
        throw new Error(`Unsupported operator in test matcher: ${op}`);
      });
    }
    return row[field] === cond;
  });
}

function makeWorld() {
  const now = Date.now();
  const future = new Date(now + HOUR_MS);

  const apiKeys: Row[] = [
    {
      id: SECRET_KEY_A,
      organizationId: ORG_A,
      name: 'Server key A',
      keyType: 'secret',
      status: 'active',
      deletedAt: null,
      apiKeyPlaintext: null,
      apiKeyLookupHash: 'hash-secret-a',
      revokedAt: null,
    },
    {
      id: PUB_KEY_A,
      organizationId: ORG_A,
      name: 'Frontend key A',
      keyType: 'publishable',
      status: 'active',
      deletedAt: null,
      apiKeyPlaintext: 'mf_pk_a',
      apiKeyLookupHash: 'hash-pub-a',
      revokedAt: null,
    },
  ];
  const customersRows: Row[] = [
    { id: CUST_A, organizationId: ORG_A, name: 'Acme', email: 'billing@acme.test' },
    { id: CUST_B, organizationId: ORG_B, name: 'Globex', email: 'billing@globex.test' },
  ];
  const magicLinks: Row[] = [
    {
      id: 'lnk-a',
      customerId: CUST_A,
      organizationId: ORG_A,
      token: hashApiKeyForLookup('mgl_live_link_org_a'),
      expiresAt: new Date(future),
      usedAt: null,
      createdAt: new Date(now),
    },
    {
      id: 'lnk-b',
      customerId: CUST_B,
      organizationId: ORG_B,
      token: hashApiKeyForLookup('mgl_live_link_org_b'),
      expiresAt: new Date(future),
      usedAt: null,
      createdAt: new Date(now),
    },
  ];
  const portalSessions: Row[] = [
    {
      id: 'ses-a',
      customerId: CUST_A,
      organizationId: ORG_A,
      token: hashApiKeyForLookup(RAW_SESSION_A),
      expiresAt: new Date(future),
    },
    {
      id: 'ses-b',
      customerId: CUST_B,
      organizationId: ORG_B,
      token: hashApiKeyForLookup(RAW_SESSION_B),
      expiresAt: new Date(future),
    },
  ];

  const customersUpdate = jest.fn();

  function withIncludes(row: Row | undefined, include?: Record<string, unknown>) {
    if (!row) return null;
    if (!include) return row;
    const joined: Row = { ...row };
    if ('customers' in include) {
      joined.customers = customersRows.find((c) => c.id === row.customerId) ?? null;
    }
    if ('organizations' in include) {
      joined.organizations = { id: row.organizationId, name: 'Org' };
    }
    return joined;
  }

  function delegateFor(rows: Row[]) {
    return {
      async findFirst(args: { where: Record<string, unknown>; include?: Record<string, unknown> }) {
        const match = rows.find((r) => rowMatches(r, args.where));
        return withIncludes(match, args.include);
      },
      async findUnique(args: {
        where: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) {
        const match = rows.find((r) => rowMatches(r, args.where));
        return withIncludes(match, args.include);
      },
      async update(args: { where: { id: string }; data: Row }) {
        const match = rows.find((r) => r.id === args.where.id);
        if (!match) throw new Error(`update miss: ${args.where.id}`);
        Object.assign(match, args.data);
        return { ...match };
      },
      async updateMany(args: { where: Record<string, unknown>; data: Row }) {
        const matched = rows.filter((r) => rowMatches(r, args.where));
        for (const row of matched) Object.assign(row, args.data);
        return { count: matched.length };
      },
      async create(args: { data: Row }) {
        const row = { id: `row-${rows.length + 1}`, createdAt: new Date(), ...args.data };
        rows.push(row);
        return { ...row };
      },
    };
  }

  const tables = { apiKeys, magicLinks, portalSessions, customersRows };

  const store: any = {
    api_keys: delegateFor(apiKeys),
    portal_magic_links: delegateFor(magicLinks),
    portal_sessions: delegateFor(portalSessions),
    customers: {
      ...delegateFor(customersRows),
      update: customersUpdate,
    },
    organizations: {
      async findUnique(args: { where: { id: string } }) {
        return { slug: args.where.id === ORG_A ? 'acme' : 'globex' };
      },
    },
    async $transaction(fn: (tx: any) => Promise<unknown>) {
      const snapshot = Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [name, structuredClone(rows)]),
      );
      try {
        return await fn(store);
      } catch (err) {
        for (const [name, rows] of Object.entries(tables)) {
          rows.splice(0, rows.length, ...(snapshot as any)[name]);
        }
        throw err;
      }
    },
  };

  const service = new ApiKeysService(store);
  const controller = new ApiKeysController(service);
  const authService = new AuthService(store);
  const portalGuard = new PortalSessionGuard(new Reflector(), authService);
  const portalSessionsService = new PortalSessionsService(store, {
    get: () => undefined,
  } as any);

  return {
    store,
    tables,
    controller,
    authService,
    portalGuard,
    portalSessionsService,
    customersUpdate,
  };
}

function portalCtx(token: string): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Anon {},
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }),
    }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// The cascade, driven through the real validators.
// ---------------------------------------------------------------------------

describe('secret-key revoke cascades to portal access (api-nest door)', () => {
  it('NEGATIVE CONTROL: before any revoke, the session validates and the portal guard passes', async () => {
    const { authService, portalGuard } = makeWorld();

    const user = await authService.validatePortalSessionToken(RAW_SESSION_A);
    expect(user).not.toBeNull();
    expect(user!.customerId).toBe(CUST_A);

    const ctx = portalCtx(RAW_SESSION_A);
    await expect(portalGuard.canActivate(ctx)).resolves.toBe(true);
  });

  it('revoking a SECRET key kills the org portal session on the next request', async () => {
    const { controller, authService, tables } = makeWorld();

    const result = await controller.revokeApiKey(ORG_A, SECRET_KEY_A);

    expect(result.portalAccess).toEqual({ magicLinksEnded: 1, portalSessionsEnded: 1 });
    await expect(authService.validatePortalSessionToken(RAW_SESSION_A)).resolves.toBeNull();

    // Parity with the dashboard door: plaintext is cleared, but the
    // lookup hash SURVIVES the revoke — that retained hash is what lets the 401
    // path recognize the dead key and answer "revoked" instead of "invalid".
    const key = tables.apiKeys.find((k) => k.id === SECRET_KEY_A)!;
    expect(key.status).toBe('revoked');
    expect(key.apiKeyLookupHash).toBe('hash-secret-a');
    expect(key.apiKeyPlaintext).toBeNull();
  });

  it("revoking a SECRET key expires the org's live magic link past the redeem predicate", async () => {
    const { controller, tables } = makeWorld();

    await controller.revokeApiKey(ORG_A, SECRET_KEY_A);

    const link = tables.magicLinks.find((l) => l.id === 'lnk-a')!;
    // The dashboard redeem route's expiry predicate: expiresAt < now -> the
    // org-branded link_expired page.
    expect(link.expiresAt < new Date()).toBe(true);
  });

  it('post-revoke, the REAL PortalSessionGuard refuses the request before any handler runs', async () => {
    const { controller, portalGuard, customersUpdate } = makeWorld();

    await controller.revokeApiKey(ORG_A, SECRET_KEY_A);

    await expect(portalGuard.canActivate(portalCtx(RAW_SESSION_A))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // The guarded write behind PATCH /portal/profile is never reached.
    expect(customersUpdate).not.toHaveBeenCalled();
  });

  it('revoking a PUBLISHABLE key cascades nothing (blast-radius control)', async () => {
    const { controller, authService, tables } = makeWorld();

    const result = await controller.revokeApiKey(ORG_A, PUB_KEY_A);

    expect(result.portalAccess).toEqual({ magicLinksEnded: 0, portalSessionsEnded: 0 });
    const user = await authService.validatePortalSessionToken(RAW_SESSION_A);
    expect(user!.customerId).toBe(CUST_A);
    expect(tables.magicLinks.find((l) => l.id === 'lnk-a')!.expiresAt > new Date()).toBe(true);
  });

  it("an org A revoke never touches org B's portal access (tenancy control)", async () => {
    const { controller, authService } = makeWorld();

    await controller.revokeApiKey(ORG_A, SECRET_KEY_A);

    const orgBUser = await authService.validatePortalSessionToken(RAW_SESSION_B);
    expect(orgBUser).not.toBeNull();
    expect(orgBUser!.customerId).toBe(CUST_B);
  });

  it('ATOMICITY: a cascade failure rolls the whole revoke back — key stays active, links stay live', async () => {
    const { controller, tables, store } = makeWorld();
    store.portal_sessions.updateMany = jest
      .fn()
      .mockRejectedValue(new Error('sessions table unavailable'));

    await expect(controller.revokeApiKey(ORG_A, SECRET_KEY_A)).rejects.toThrow(
      'sessions table unavailable',
    );

    const key = tables.apiKeys.find((k) => k.id === SECRET_KEY_A)!;
    expect(key.status).toBe('active');
    expect(key.apiKeyLookupHash).toBe('hash-secret-a');
    // The links cascade ran before the sessions one — the rollback must undo it.
    expect(tables.magicLinks.find((l) => l.id === 'lnk-a')!.expiresAt > new Date()).toBe(true);
  });

  it('NORMAL FLOW: an active secret key still mints a magic link end to end', async () => {
    const { portalSessionsService, tables } = makeWorld();

    const created = await portalSessionsService.createPortalSession(
      ORG_A,
      { customerId: CUST_A } as any,
      SECRET_KEY_A,
    );

    expect(created.url).toContain('/r/mgl_');
    expect(created.token!.startsWith('mgl_')).toBe(true);
    const row = tables.magicLinks.find((l) => l.token === hashApiKeyForLookup(created.token!));
    expect(row).toBeDefined();
    expect(row!.expiresAt > new Date()).toBe(true);
  });

  it('RACE CLOSER: a mint whose key was revoked mid-flight refuses and writes no link', async () => {
    const { controller, portalSessionsService, tables } = makeWorld();
    const linksBefore = tables.magicLinks.length;

    // The revoke lands between SecretKeyGuard passing and the link insert.
    await controller.revokeApiKey(ORG_A, SECRET_KEY_A);

    await expect(
      portalSessionsService.createPortalSession(ORG_A, { customerId: CUST_A } as any, SECRET_KEY_A),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tables.magicLinks.length).toBe(linksBefore);
  });

  it('ROUTE GATE: a member is 403ed at the revoke door and no portal row is touched', async () => {
    const { tables } = makeWorld();
    const findFirst = jest.fn().mockResolvedValue({ role: 'member' });
    const guard = new OrgRoleGuard({ ba_member: { findFirst } } as any, new Reflector());
    const ctx = {
      getHandler: () => ApiKeysController.prototype.revokeApiKey,
      getClass: () => ApiKeysController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { authMethod: 'session', userId: 'human-1', organizationId: ORG_A },
          params: { orgId: ORG_A },
        }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tables.portalSessions.find((s) => s.id === 'ses-a')!.expiresAt > new Date()).toBe(true);
  });
});
