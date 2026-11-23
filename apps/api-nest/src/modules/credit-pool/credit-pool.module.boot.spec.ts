import { Test } from '@nestjs/testing';

// Compiles the REAL application graph. Unit specs stub guards, so a module
// missing an import (for example CreditPoolModule without AuthModule) stays
// green in jest and fails at boot. compile() instantiates the full DI graph
// without opening sockets; the dummy env below only has to exist at
// construction time. AppModule is imported after the env is set because its
// configuration is validated as soon as the module loads.
describe('api-nest boot', () => {
  it('the full AppModule graph compiles with no email provider configured', async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/boot_spec';
    process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? 'boot-spec-secret';
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? 'boot-spec-secret';
    process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;

    const { AppModule } = await import('../../app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30000);
});
