import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AuthService } from './auth.service';
import { CustomerFailureAlertService } from './customer-failure-alert.service';
import { RevokedKeyNoticeService } from './revoked-key-notice.service';
import { AuthFailureThrottleService } from './auth-failure-throttle.service';
import { CombinedAuthGuard } from './guards/combined-auth.guard';
import { PerTenantThrottlerGuard } from './guards/per-tenant-throttler.guard';
import { PublishableKeyReadGuard } from '../../common/guards/publishable-key-read.guard';
import { IngestKeyScopeGuard } from '../../common/guards/ingest-key-scope.guard';
import { LegalKeyScopeGuard } from '../../common/guards/legal-key-scope.guard';
import { EmailModule } from '../email/email.module';

/**
 * Auth Module
 *
 * This module provides authentication using Better Auth JWT tokens and API keys.
 * - Better Auth handles user registration, login, logout, and session management
 * - This module only handles JWT validation via JWKS and API key validation
 * - CombinedAuthGuard is registered as the global APP_GUARD
 * - PerTenantThrottlerGuard is registered AFTER CombinedAuthGuard so it can
 *   read req.user.organizationId for per-tenant rate-limit bucketing.
 *   NestJS executes APP_GUARD providers in the order they appear in this
 *   module's providers array — auth MUST run before the throttler.
 */
@Module({
  // EmailModule (not @Global) feeds RevokedKeyNoticeService; PrismaModule is
  // @Global so Prisma needs no import here.
  imports: [ConfigModule, EmailModule],
  providers: [
    AuthService,
    // Per-bucket repeated-failure counter + Slack alerter spanning every
    // customer-failure class (auth_401 + bad_data/forbidden/rate_limit). The
    // ONLY consumer is the global CustomerFailureAlertFilter (which owns 401
    // too); CombinedAuthGuard does not inject it. It must be a provider here
    // and EXPORTED so the AppModule-level filter can resolve it (see exports note).
    CustomerFailureAlertService,
    // The revoked-key owner-email sender, injected into
    // CustomerFailureAlertService (which owns the Redis cooldown around it).
    RevokedKeyNoticeService,
    // Per-IP counter for FAILED api-key attempts, injected into
    // CombinedAuthGuard as a gate (not a recorder). Must be EXPORTED too — see
    // the exports note below.
    AuthFailureThrottleService,
    // Register CombinedAuthGuard as global guard (must come first so it
    // populates req.user before the throttler reads it).
    {
      provide: APP_GUARD,
      useClass: CombinedAuthGuard,
    },
    // Rate-limit guard, keyed per organizationId for authed requests and
    // per IP for anonymous. Reads ThrottlerModule config from AppModule.
    {
      provide: APP_GUARD,
      useClass: PerTenantThrottlerGuard,
    },
    // Publishable-key boundary, deny-by-default on every method. A fail-open here
    // un-gates the ENTIRE API.
    // Position is load-bearing twice over: it must sit AFTER CombinedAuthGuard in THIS
    // module (root-module APP_GUARDs run before imported modules', so an app.module.ts
    // registration would see request.user undefined and fail open), and as a global
    // guard it still runs BEFORE any route-scoped OrgRoleGuard — so a publishable key
    // gets "use your secret key", not a role message pointing at the wrong fix.
    {
      provide: APP_GUARD,
      useClass: PublishableKeyReadGuard,
    },
    // Ingest-key ROLE boundary: deny-by-default for an ingest-role
    // key on every method of every authenticated route. Position is load-bearing twice,
    // and getting either wrong ships GREEN. It must sit after CombinedAuthGuard in THIS
    // module (a root-module registration reads request.user as undefined and fail-opens
    // the entire API), and after PublishableKeyReadGuard, so a publishable key whose
    // blob floored to 'ingest' is told to send its secret key rather than to change its
    // key's role. App B of ingest-key-scope.guard.http.spec.ts pins the first trap.
    {
      provide: APP_GUARD,
      useClass: IngestKeyScopeGuard,
    },
    // Legal-key ROLE boundary: deny-by-default for a legal-role key outside
    // the Law surface (@OrgRoles-with-legal routes) + the ingest-reachable handlers.
    // Same registration trap as the ingest guard above: it must sit in THIS module
    // (a root-module registration reads request.user as undefined and fail-opens the
    // entire API), and LAST, so the publishable/ingest guards answer first with the
    // error that names the right fix. App B of legal-key-scope.guard.http.spec.ts pins it.
    {
      provide: APP_GUARD,
      useClass: LegalKeyScopeGuard,
    },
  ],
  // TWO separate reasons live here, and dropping either export breaks BOOT, not
  // a test:
  //
  // 1. CustomerFailureAlertService — the global CustomerFailureAlertFilter is
  //    registered as an APP_FILTER in AppModule (which imports AuthModule) and
  //    injects this service.
  //
  // 2. AuthFailureThrottleService — CombinedAuthGuard's 4th dep. FIVE controllers
  //    apply the guard at CONTROLLER scope via @UseGuards, so Nest builds a guard
  //    instance inside each of THEIR injectors, and those can only see AuthModule's
  //    EXPORTED providers: SdkController, SdkPublicAliasesController,
  //    CostControlController, CreditPoolController, CustomerAlertsController. All
  //    five modules import AuthModule, so this one export covers them.
  //    auth.module.di.spec.ts and credit-pool.module.boot.spec.ts are what catch a miss.
  exports: [AuthService, CustomerFailureAlertService, AuthFailureThrottleService],
})
export class AuthModule {}
