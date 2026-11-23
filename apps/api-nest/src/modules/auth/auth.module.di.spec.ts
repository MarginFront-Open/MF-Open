/**
 * WHAT THIS FILE DOES:
 *   A Nest dependency-injection BOOTSTRAP test. The unit specs construct the
 *   guard and the filter by hand (`new CombinedAuthGuard(...)` /
 *   `new CustomerFailureAlertFilter(...)`), which never exercises the Nest
 *   container — so they stay green even if the app can't actually start. This
 *   test closes that gap by compiling, through the REAL Nest injector, a module
 *   that wires up BOTH the things that depend on AuthModule's exports.
 *
 * WHY BOTH EXPORTS ARE LOAD-BEARING (the two shapes this compiles):
 *   1. A controller-scoped CombinedAuthGuard. FIVE real controllers apply it via
 *      @UseGuards (SdkController, SdkPublicAliasesController, CostControlController,
 *      CreditPoolController, CustomerAlertsController), so Nest builds the guard
 *      inside THEIR injectors, which see only AuthModule's EXPORTED providers.
 *      The guard's 4th dep (AuthFailureThrottleService) is why this export matters.
 *   2. An APP_FILTER CustomerFailureAlertFilter, which injects
 *      CustomerFailureAlertService through AuthModule's export.
 *   Dropping either export makes compiling this module throw a Nest DI error
 *   instead of silently shipping an app that cannot boot.
 *
 * This is the FAST detector, not the strongest one:
 *   credit-pool.module.boot.spec.ts compiles the REAL AppModule graph and would
 *   also catch a missing export. It is slower and names the cause less precisely,
 *   so keep both — and keep it in the sweep whenever guard deps change.
 */
import { Controller, Get, Logger, Module, UseGuards } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CustomerFailureAlertFilter } from '../../common/filters/customer-failure-alert.filter';
import { AuthModule } from './auth.module';
import { CustomerFailureAlertService } from './customer-failure-alert.service';
import { RevokedKeyNoticeService } from './revoked-key-notice.service';
import { AuthFailureThrottleService } from './auth-failure-throttle.service';
import { CombinedAuthGuard } from './guards/combined-auth.guard';

// Mirrors SdkController/SdkPublicAliasesController: a controller that applies
// CombinedAuthGuard at CONTROLLER scope, so the guard is instantiated inside a
// downstream module's injector rather than as the global APP_GUARD.
@Controller('di-probe')
@UseGuards(CombinedAuthGuard)
class DiProbeController {
  @Get()
  ping() {
    return 'ok';
  }
}

// Structural twin of the real wiring: imports AuthModule, owns a controller that
// uses @UseGuards(CombinedAuthGuard) (the controller-scoped guard), AND registers
// the global CustomerFailureAlertFilter as an APP_FILTER (the filter that injects
// CustomerFailureAlertService). If AuthModule under-exports, compiling THIS module
// is what throws.
@Module({
  imports: [AuthModule],
  controllers: [DiProbeController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: CustomerFailureAlertFilter,
    },
  ],
})
class DiProbeModule {}

describe('AuthModule DI bootstrap (controller-scoped guard + APP_FILTER both resolve)', () => {
  beforeAll(() => {
    // PrismaService logs on init and CustomerFailureAlertService logs once when no
    // REDIS_URL is set (degraded). Neither affects DI; keep test output clean.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('compiles the real-wiring graph: the controller-scoped guard AND the APP_FILTER both resolve', async () => {
    // .compile() runs the real dependency scanner + instance loader, which
    // instantiates controllers, their bound enhancers (the guard), and the
    // APP_FILTER (the filter). A missing export surfaces HERE as a thrown DI
    // error. We never call .init(), so no DB connect / Redis connect happens —
    // this stays a pure wiring test.
    const moduleRef = await Test.createTestingModule({
      imports: [
        // AuthModule imports EmailModule, and EmailService's
        // constructor getOrThrows RESEND_FROM_EMAIL + FRONTEND_URL — .compile()
        // instantiates it eagerly, so the config MUST supply both or this spec
        // throws in any environment without a real .env (CI). Module-scoped
        // via `load`, never process.env.
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              RESEND_FROM_EMAIL: 'MarginFront <team@test.invalid>',
              FRONTEND_URL: 'http://localhost:3000',
            }),
          ],
        }),
        // @Global ThrottlerModule — satisfies the PerTenantThrottlerGuard
        // APP_GUARD that AuthModule registers, so AuthModule can compile.
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] }),
        // @Global — provides PrismaService for AuthService.
        PrismaModule,
        DiProbeModule,
      ],
    }).compile();

    // If we got here, DI resolved. Prove the exported dep is actually
    // reachable from the compiled container (not just absent-and-ignored) — this
    // is the dependency the APP_FILTER pulls.
    const alertService = moduleRef.get(CustomerFailureAlertService, { strict: false });
    expect(alertService).toBeInstanceOf(CustomerFailureAlertService);

    // The alert service's owner-email sender dep must
    // resolve through AuthModule's EmailModule import, or the app can't boot.
    const noticeService = moduleRef.get(RevokedKeyNoticeService, { strict: false });
    expect(noticeService).toBeInstanceOf(RevokedKeyNoticeService);

    // The guard's 4th dep. Drop it from AuthModule's exports and the
    // five controllers that build the guard in their own injectors can't resolve
    // it — the app compiles clean and refuses to boot.
    const throttleService = moduleRef.get(AuthFailureThrottleService, { strict: false });
    expect(throttleService).toBeInstanceOf(AuthFailureThrottleService);

    // The controller-scoped guard resolved too.
    const probe = moduleRef.get(DiProbeController, { strict: false });
    expect(probe).toBeInstanceOf(DiProbeController);

    await moduleRef.close();
  });
});
