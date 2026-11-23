/**
 * WHAT THIS FILE DOES:
 *   Integration proof against a REAL Postgres: the DB unique index
 *   `uq_customer_alerts_functional_tuple` (NULLS NOT DISTINCT) actually stops
 *   the duplicate-watch race the app-level findFirst guards can't. Two legs:
 *     1. Migration mechanics — from-zero `migrate deploy` lands the index with
 *        the right shape (unique, NULLS NOT DISTINCT, the 8-column functional
 *        tuple), and `migrate diff` sees the hand-written index and the
 *        schema's @@unique as the SAME object (no drift churn in future
 *        migrations).
 *     2. Service behavior — CustomerAlertsService with a real PrismaClient:
 *        concurrent identical creates yield exactly one row and one 409 with
 *        the app-level wording; same for concurrent updates shaping the same
 *        tuple; and a direct-insert NULL-custom-dates twin is refused by the
 *        DATABASE (the case a plain unique index waves through, because
 *        Postgres treats NULLs as distinct without NULLS NOT DISTINCT).
 *
 * WHEN IT RUNS:
 *   DB-GATED — needs a THROWAWAY/scratch Postgres database (never one that
 *   holds data you want) reachable at `CUSTOMER_ALERTS_TEST_DATABASE_URL`.
 *   Self-skips loudly when the var is absent (api-nest integration-test
 *   convention, see webhook-dedupe.integration.spec.ts). The suite RESETS the
 *   scratch database (DROP SCHEMA public CASCADE) at start, so it is
 *   rerunnable; everything in that database is disposable by definition.
 *
 * WHY IT EXISTS:
 *   An application-level duplicate guard (findFirst then create) lets two
 *   concurrent identical requests both pass the check and land twin watches
 *   (= double alert emails per crossing). The unit spec mocks Prisma and can
 *   prove the P2002 → 409 mapping, but only a real database can prove the index
 *   exists, has NULLS NOT DISTINCT semantics, and closes the race end to end.
 *
 * CONNECTS TO: customer-alerts.service.ts (the guards + P2002 backstop),
 *   packages/db/prisma/migrations/0_init (the baseline that creates the index),
 *   packages/db/prisma/schema.prisma (the @@unique declaration).
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@marginfront/db';
import { CustomerAlertsService } from './customer-alerts.service';
import { CreateCustomerAlertDto } from './dto/create-customer-alert.dto';

const SCRATCH_DB_URL = process.env.CUSTOMER_ALERTS_TEST_DATABASE_URL;
const HAS_SCRATCH_DB = Boolean(SCRATCH_DB_URL);
if (!HAS_SCRATCH_DB) {
  // eslint-disable-next-line no-console -- explains why the suite skipped
  console.warn(
    '[customer-alerts-db-unique.integration.spec] CUSTOMER_ALERTS_TEST_DATABASE_URL not set — ' +
      'skipping (DB-gated, needs a disposable scratch Postgres, see the header).',
  );
}
const describeIfDb = HAS_SCRATCH_DB ? describe : describe.skip;

// This file sits at apps/api-nest/src/modules/customer-alerts/ — five levels
// below the monorepo root. packages/db holds schema.prisma, the migrations,
// and the prisma CLI devDependency.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const PACKAGES_DB = join(REPO_ROOT, 'packages', 'db');
const SCHEMA_PATH = join(PACKAGES_DB, 'prisma', 'schema.prisma');

const INDEX_NAME = 'uq_customer_alerts_functional_tuple';

const DEPLOY_ENV = {
  DATABASE_URL: SCRATCH_DB_URL!,
  DATABASE_URL_UNPOOLED: SCRATCH_DB_URL!,
};

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync(cmd, args, {
    cwd: PACKAGES_DB,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Feed SQL to `prisma db execute --stdin` against the scratch DB. */
function executeSql(sql: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--stdin', '--url', SCRATCH_DB_URL!], {
    cwd: PACKAGES_DB,
    env: { ...process.env },
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function deployAll(): string {
  return run('npx', ['prisma', 'migrate', 'deploy'], DEPLOY_ENV);
}

// Fixed ids so every assertion is deterministic and reruns collide with
// nothing (the reset wipes them anyway).
const ORG_ID = '72200000-0000-4000-8000-000000000001';
const USER_ID = '72200000-0000-4000-8000-000000000002';
const CUSTOMER_ID = '72200000-0000-4000-8000-000000000003';
const RECIPIENT_EMAIL = 'finance@test.local';

const seedWorldSql = `
INSERT INTO "organizations" ("id", "name") VALUES ('${ORG_ID}', 'Scratch org');
INSERT INTO "users" ("id", "name", "email", "createdAt", "updatedAt")
  VALUES ('${USER_ID}', 'Scratch finance', '${RECIPIENT_EMAIL}', now(), now());
INSERT INTO "ba_member" ("id", "organizationId", "userId", "role", "createdAt")
  VALUES ('72200000-0000-4000-8000-000000000004', '${ORG_ID}', '${USER_ID}', 'finance', now());
INSERT INTO "customers" ("id", "name", "organizationId", "createdAt", "updatedAt")
  VALUES ('${CUSTOMER_ID}', 'Scratch Customer', '${ORG_ID}', now(), now());
`;

describeIfDb('customer_alerts unique index against a real Postgres', () => {
  jest.setTimeout(240_000);

  let prisma: PrismaClient;

  beforeAll(async () => {
    // Reset: the scratch DB is disposable by contract, so every run starts
    // from an empty database.
    executeSql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    deployAll();
    executeSql(seedWorldSql);
    prisma = new PrismaClient({ datasourceUrl: SCRATCH_DB_URL! });
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe('migration mechanics', () => {
    it('from-zero deploy lands a UNIQUE, NULLS NOT DISTINCT index on the exact functional tuple', async () => {
      const rows = await prisma.$queryRawUnsafe<
        { indisunique: boolean; indnullsnotdistinct: boolean; def: string }[]
      >(
        `SELECT i.indisunique, i.indnullsnotdistinct, pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = '${INDEX_NAME}'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indisunique).toBe(true);
      // The load-bearing property: without it, Postgres treats NULLs as
      // distinct and two month/rolling watches (NULL custom dates) coexist.
      expect(rows[0].indnullsnotdistinct).toBe(true);
      expect(rows[0].def).toContain(
        '("orgId", "customerId", metric, "windowMode", "thresholdUsd", "recipientUserId", "customStartDate", "customEndDate")',
      );
      expect(rows[0].def).toContain('NULLS NOT DISTINCT');
    });

    it('migrate diff treats the hand-written index and the schema @@unique as the SAME object', () => {
      // Pins the property that makes the hand-written NULLS NOT DISTINCT SQL
      // safe: the diff engine introspects the deployed index as equal to the
      // schema's @@unique, so no future auto-generated migration will drop or
      // recreate it.
      const drift = run('npx', [
        'prisma',
        'migrate',
        'diff',
        '--script',
        '--from-url',
        SCRATCH_DB_URL!,
        '--to-schema-datamodel',
        SCHEMA_PATH,
      ]);
      expect(drift).not.toContain(INDEX_NAME);
      expect(drift).not.toContain('"customer_alerts"');
    });
  });

  describe('service behavior under the index', () => {
    let service: CustomerAlertsService;

    const CREATE_409 =
      'An identical watch already exists for this customer (same metric, window, ' +
      'threshold, and recipient). Edit that one instead of creating a copy.';
    const UPDATE_409 =
      'This edit makes the watch identical to another watch on this customer ' +
      '(same metric, window, threshold, and recipient). Edit that one instead, ' +
      'or delete one of them.';

    const dto = (over: Partial<CreateCustomerAlertDto> = {}): CreateCustomerAlertDto =>
      ({
        customerId: CUSTOMER_ID,
        metric: 'cost',
        thresholdUsd: 500,
        windowMode: 'month',
        ...over,
      }) as CreateCustomerAlertDto;

    beforeAll(() => {
      // Real Prisma, stubbed edges: email returns null (the unconfigured-env
      // path — never fatal), and the metrics reader throws because the CRUD
      // paths under test must never evaluate anything.
      const email = {
        sendCustomerAlertConfirmationEmail: async () => null,
        sendCustomerAlertEmail: async () => null,
      };
      const revenueMetrics = {
        getCostMetrics: () => {
          throw new Error('CRUD must not evaluate metrics');
        },
        getRevenueMetrics: () => {
          throw new Error('CRUD must not evaluate metrics');
        },
      };
      service = new CustomerAlertsService(prisma as never, email as never, revenueMetrics as never);
    });

    beforeEach(async () => {
      // Each test starts from an empty watch table (ledger rows cascade).
      await prisma.customer_alerts.deleteMany({});
    });

    const settle = async (a: Promise<unknown>, b: Promise<unknown>) => {
      const results = await Promise.allSettled([a, b]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      return { fulfilled, rejected };
    };

    it('two concurrent identical creates (month mode, NULL dates) → one row, one 409, app wording', async () => {
      const { fulfilled, rejected } = await settle(
        service.createAlert(ORG_ID, USER_ID, dto()),
        service.createAlert(ORG_ID, USER_ID, dto()),
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect((rejected[0].reason as ConflictException).message).toBe(CREATE_409);
      expect(await prisma.customer_alerts.count()).toBe(1);
    });

    it('two concurrent identical creates (custom mode, same dates) → one row, one 409', async () => {
      const customDto = () =>
        dto({
          windowMode: 'custom',
          customStartDate: '2026-09-01T00:00:00.000Z',
          customEndDate: '2026-09-30T00:00:00.000Z',
        });
      const { fulfilled, rejected } = await settle(
        service.createAlert(ORG_ID, USER_ID, customDto()),
        service.createAlert(ORG_ID, USER_ID, customDto()),
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect((rejected[0].reason as ConflictException).message).toBe(CREATE_409);
      expect(await prisma.customer_alerts.count()).toBe(1);
    });

    it('a NULL-custom-dates twin is refused by the DATABASE, not just the app guard', async () => {
      // Straight inserts, bypassing the service entirely — this is the exact
      // case a plain unique index waves through (NULL != NULL in Postgres
      // without NULLS NOT DISTINCT), i.e. the twins the index exists to
      // prevent.
      const row = {
        orgId: ORG_ID,
        customerId: CUSTOMER_ID,
        metric: 'cost',
        thresholdUsd: 500,
        windowMode: 'month',
        customStartDate: null,
        customEndDate: null,
        recipientEmail: RECIPIENT_EMAIL,
        recipientUserId: USER_ID,
      };
      await prisma.customer_alerts.create({ data: row });
      const err = await prisma.customer_alerts
        .create({ data: row })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
      expect(await prisma.customer_alerts.count()).toBe(1);
    });

    it('near-duplicates still coexist — the index is not overbroad', async () => {
      await service.createAlert(ORG_ID, USER_ID, dto());
      await service.createAlert(ORG_ID, USER_ID, dto({ thresholdUsd: 900 }));
      await service.createAlert(ORG_ID, USER_ID, dto({ metric: 'revenue' }));
      await service.createAlert(
        ORG_ID,
        USER_ID,
        dto({
          windowMode: 'custom',
          customStartDate: '2026-09-01T00:00:00.000Z',
          customEndDate: '2026-09-30T00:00:00.000Z',
        }),
      );
      await service.createAlert(
        ORG_ID,
        USER_ID,
        dto({
          windowMode: 'custom',
          customStartDate: '2026-09-01T00:00:00.000Z',
          customEndDate: '2026-10-31T00:00:00.000Z',
        }),
      );
      expect(await prisma.customer_alerts.count()).toBe(5);
    });

    it('two concurrent edits shaping the SAME tuple → one wins, one 409 with the update wording', async () => {
      const a = await service.createAlert(ORG_ID, USER_ID, dto({ thresholdUsd: 500 }));
      const b = await service.createAlert(ORG_ID, USER_ID, dto({ thresholdUsd: 900 }));

      const { fulfilled, rejected } = await settle(
        service.updateAlert(ORG_ID, a.id, USER_ID, { thresholdUsd: 700 }),
        service.updateAlert(ORG_ID, b.id, USER_ID, { thresholdUsd: 700 }),
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect((rejected[0].reason as ConflictException).message).toBe(UPDATE_409);

      const at700 = await prisma.customer_alerts.count({
        where: { thresholdUsd: 700 },
      });
      expect(at700).toBe(1);
      expect(await prisma.customer_alerts.count()).toBe(2);
    });
  });
});
