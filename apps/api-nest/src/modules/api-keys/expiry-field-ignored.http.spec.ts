/**
 * An inbound `expiresAt` on the mint routes is IGNORED, never stored.
 *
 * "Ignored" is a property of the PIPE, not the DTO, so this file boots a real app with
 * main.ts's exact ValidationPipe options. Asserted against the DTO alone it would prove
 * nothing.
 *
 * The malformed-date case leads because it is the one that would fail if someone
 * added a date validator: with @Type + @IsDate on the field, a malformed expiresAt
 * becomes Invalid Date and 400s. A VALID ISO date answers 201 either way, so that
 * case alone could never catch it.
 *
 * The row assertions are not vacuous either: whitelist:false does NOT strip the unknown
 * property, so an inbound expiresAt still lands on the DTO instance as a raw string. It
 * reaches no row only because both create paths build their Prisma `data` field by
 * field and never spread the dto. Add `expiresAt: dto.expiresAt || null` to any of
 * them and the `'expiresAt' in data` assertions go red. `in` is deliberate over
 * toBeUndefined(), which passes on a present-but-undefined key.
 */

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';

const ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OWNER_UUID = 'owner-1111-2222-3333-444455556666';
const VALID_EXPIRY = '2027-01-01T00:00:00.000Z';

// Two bcrypt hashes at SALT_ROUNDS=10 run on the pair route; Jest's 5s default is tight.
jest.setTimeout(30_000);

let createdRows: Array<Record<string, unknown>>;

async function bootApp(): Promise<INestApplication> {
  createdRows = [];
  const create = jest.fn((args: { data: Record<string, unknown> }) => {
    createdRows.push(args.data);
    return { id: `id-${createdRows.length}`, name: args.data.name, createdAt: new Date() };
  });
  const prisma = {
    api_keys: { create },
    // $transaction receives rows already built by the synchronous create stub.
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
    ba_member: { findFirst: jest.fn().mockResolvedValue({ role: 'owner' }) },
  } as unknown as PrismaService;

  const moduleRef = await Test.createTestingModule({
    controllers: [ApiKeysController],
    providers: [ApiKeysService, { provide: PrismaService, useValue: prisma }],
  })
    // The route gate is proven exhaustively by mint-ceiling.spec.ts; this file is
    // about the pipe. A missed override would surface as a 401, not a false green.
    .overrideGuard(OrgRoleGuard)
    .useValue({
      canActivate: (context: any) => {
        context.switchToHttp().getRequest().user = {
          id: OWNER_UUID,
          userId: OWNER_UUID,
          email: 'owner@example.com',
          authMethod: 'session',
          organizationId: ORG_ID,
        };
        return true;
      },
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  // Identical options to the global pipe in main.ts.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: false,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  await app.listen(0);
  return app;
}

async function postMint(app: INestApplication, path: string, body: unknown) {
  const response = await fetch(`${await app.getUrl()}/v1/org/${ORG_ID}/developer/api-keys${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status };
}

describe('expiresAt on the mint routes', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await bootApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('the pair route', () => {
    it('a MALFORMED expiresAt is ignored, not a 400', async () => {
      const { status } = await postMint(app, '/pair', {
        name: 'Legacy caller',
        role: 'ingest',
        expiresAt: 'whenever',
      });
      expect(status).toBe(201);
    });

    it('a valid ISO expiresAt mints a key', async () => {
      const { status } = await postMint(app, '/pair', {
        name: 'Legacy caller',
        role: 'ingest',
        expiresAt: VALID_EXPIRY,
      });
      expect(status).toBe(201);
    });

    it('neither half of the pair carries expiresAt into the row', async () => {
      await postMint(app, '/pair', {
        name: 'Legacy caller',
        role: 'ingest',
        expiresAt: VALID_EXPIRY,
      });
      expect(createdRows).toHaveLength(2);
      for (const row of createdRows) {
        expect('expiresAt' in row).toBe(false);
      }
    });
  });
});
