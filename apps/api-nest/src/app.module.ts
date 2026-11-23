import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { SentryModule } from '@sentry/nestjs/setup';
import { AppController } from './app.controller';
// Rate-limit bucket definitions (single source of truth, shared with the
// enforcement tests). See the file header for the minimum-of-all-buckets gotcha.
import { buildThrottlerBuckets } from './common/throttler/throttler.config';
import { AppService } from './app.service';
import { PrismaModule } from './common/prisma/prisma.module';
import { validateEnvironment } from './common/config/app-config';
// Global crypto module. Provides CryptoService to any consumer that needs AES-256-GCM
// encrypt/decrypt at rest (payment provider credentials).
import { CryptoModule } from './common/crypto/crypto.module';
import { CustomerFailureAlertFilter } from './common/filters/customer-failure-alert.filter';
import { JsonBodyDepthGuard } from './common/guards/json-body-depth.guard';
import { AuditLoggingInterceptor } from './common/interceptors/audit-logging.interceptor';
import { PublishableKeyWriteGuardInterceptor } from './common/interceptors/publishable-key-write-guard.interceptor';
import { SentryContextInterceptor } from './common/interceptors/sentry-context.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { LoggerModule } from './common/logger/logger.module';
import { AgentsModule } from './modules/agents/agents.module';
import { PricingPlansModule } from './modules/pricing-plans/pricing-plans.module';
import { PricingStrategiesModule } from './modules/pricing-strategies/pricing-strategies.module';
import { SignalsModule } from './modules/signals/signals.module';
import { SignalEventsModule } from './modules/signal-events/signal-events.module';
import { MattersModule } from './modules/matters/matters.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { PaymentProvidersModule } from './modules/payment-providers/payment-providers.module';
import { TeamModule } from './modules/team/team.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { SdkModule } from './modules/sdk/sdk.module';
import { PublicInvoiceModule } from './modules/public-invoice/public-invoice.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { StripeConnectModule } from './modules/stripe-connect/stripe-connect.module';
import { InvoiceCalculatorModule } from './modules/invoice-calculator/invoice-calculator.module';
import { UsersModule } from './modules/users/users.module';
import { FiltersModule } from './modules/filters/filters.module';
import { PortalSessionsModule } from './modules/portal-sessions/portal-sessions.module';
import { PublicModule } from './modules/public/public.module';
import { PortalApiModule } from './modules/portal-api/portal-api.module';
import { ServicePricingModule } from './modules/service-pricing/service-pricing.module';
import { CostControlModule } from './modules/cost-control/cost-control.module';
import { CustomerAlertsModule } from './modules/customer-alerts/customer-alerts.module';

@Module({
  imports: [
    // Sentry — must be the first imported module so its global exception
    // filter wraps every controller. Reads SENTRY_DSN from env at startup
    // (see instrument.ts).
    SentryModule.forRoot(),

    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnvironment,
    }),

    // Rate limiting — three named buckets, Redis-backed for multi-instance.
    // Bucket definitions live in common/throttler/throttler.config.ts so the
    // enforcement tests read the EXACT same config prod runs (read that file's
    // header before changing limits — the minimum-of-all-buckets behavior is
    // load-bearing). Summary:
    //
    // - "default" (1200/min/org) governs authenticated dashboard/business-API
    //   traffic. With the public bucket's skipIf (below) this is the real
    //   floor on the human app.
    // - "sdk" (60000/min/org) governs high-volume SDK ingestion routes, which
    //   @SkipThrottle the other two buckets so only this one applies.
    // - "public" (60/min/IP) governs ANONYMOUS surfaces only (public invoice
    //   links). It carries a skipIf that turns it OFF for
    //   authenticated requests — without that skipIf, because every bucket
    //   applies to every request and the lowest wins, public's 60/min would
    //   silently cap the ENTIRE authed dashboard at 60/min/org instead of 1200.
    //
    // Storage MUST be shared across instances. Serverless hosts and Docker
    // both run multiple processes; in-memory counters would not actually
    // enforce limits because each instance keeps its own count.
    ThrottlerModule.forRootAsync({
      useFactory: () => {
        // Breadcrumb so cold-start logs show whether the factory runs,
        // completes or throws.
        console.log('[ThrottlerModule] useFactory invoked');

        // REDIS_URL_REDIS_URL is the name a hosted Redis integration produces
        // when its env-var prefix is set to "REDIS_URL". Either name works, so
        // local dev with a bare REDIS_URL needs nothing extra.
        const redisUrl = process.env.REDIS_URL_REDIS_URL || process.env.REDIS_URL;
        console.log(
          `[ThrottlerModule] REDIS_URL_REDIS_URL=${!!process.env.REDIS_URL_REDIS_URL} REDIS_URL=${!!process.env.REDIS_URL}`,
        );
        if (!redisUrl) {
          if (process.env.NODE_ENV === 'production') {
            // Don't throw. A throw here takes down the entire ThrottlerModule
            // init, leaving the global guard with no config and crashing every
            // request with "this.throttlers is not iterable". Log loudly and
            // fall through to in-memory storage instead. The guard
            // (RATE_LIMIT_STORE_FAILURE_MODE) still decides; this only keeps the
            // module from being left unconfigured.
            console.error(
              '[ThrottlerModule] REDIS_URL_REDIS_URL (or REDIS_URL) missing in production — falling back to in-memory storage. ALERT: rate limiting is per-instance only until this is fixed.',
            );
          } else {
            console.warn(
              '[ThrottlerModule] No Redis URL set — rate limiting will use in-memory storage (NOT safe for multi-instance/serverless)',
            );
          }
        }
        // lazyConnect: true defers the actual Redis TCP handshake until the
        // first command is issued, not at construction. This matters on
        // a serverless cold start: if a hosted Redis is suspended (idle
        // scale-to-zero), an immediate connect can blow up before the
        // useFactory returns, which leaves ThrottlerModule with no config
        // and PerTenantThrottlerGuard with no `throttlers` array — every
        // subsequent request then throws "this.throttlers is not iterable"
        // until the host recycles the broken instance.
        //
        // The trade-off: a permanently-bad REDIS_URL would only surface on
        // first request, not at boot. That's acceptable because (a) the URL-
        // existence check above still fires at boot, and (b) a bad URL fails
        // the first request loudly.
        let redis: Redis | null = null;
        if (redisUrl) {
          try {
            redis = new Redis(redisUrl, {
              lazyConnect: true,
              maxRetriesPerRequest: 3,
              // enableOfflineQueue MUST be true on serverless. With lazyConnect,
              // the very first request after a cold-start fires its throttler
              // increment BEFORE the Redis TCP handshake completes — with the
              // queue off, ioredis throws "Stream isn't writeable" and the
              // request 500s. With the queue on, the command holds for a few
              // ms until the connection lands. maxRetriesPerRequest still caps
              // the worst case at 3 attempts, so a hard-down Redis still fails
              // fast instead of queueing forever.
              enableOfflineQueue: true,
            });
            // Swallow Redis errors so a transient network blip can't crash the
            // node process. The throttler guard already degrades gracefully
            // when Redis commands fail.
            redis.on('error', (err) => {
              console.warn('[ThrottlerModule] Redis error event:', err.message);
            });
          } catch (err) {
            console.warn(
              '[ThrottlerModule] Redis construction failed, falling back to in-memory storage:',
              err,
            );
            redis = null;
          }
        }

        // If ThrottlerStorageRedisService throws (for example an ioredis
        // identity mismatch from a duplicated package install), the factory
        // must still return options, or the global throttler guard is left
        // with none.
        let storage = undefined;
        if (redis) {
          try {
            storage = new ThrottlerStorageRedisService(redis);
          } catch (err) {
            console.error(
              '[ThrottlerModule] ThrottlerStorageRedisService construction failed, falling back to in-memory storage:',
              err,
            );
            storage = undefined;
          }
        }

        console.log(
          `[ThrottlerModule] useFactory returning (storage=${storage ? 'redis' : 'in-memory'})`,
        );
        return {
          // Shared bucket defs (incl. the public-bucket skipIf that scopes it to
          // anonymous traffic). Single source of truth — see throttler.config.ts.
          throttlers: buildThrottlerBuckets(),
          storage,
        };
      },
    }),

    // Common modules
    PrismaModule,
    LoggerModule,
    // Encrypt-at-rest for payment_providers.encrypted_secrets.
    CryptoModule,

    // Feature modules
    AuthModule,
    UsersModule,
    OrganizationsModule,
    OnboardingModule,
    SubscriptionModule,
    InvoicesModule,
    CustomersModule,
    ApiKeysModule,
    StripeConnectModule,
    InvoiceCalculatorModule,
    AgentsModule,
    PricingPlansModule,
    PricingStrategiesModule,
    SignalsModule,
    SignalEventsModule,
    MattersModule,
    ServicePricingModule,
    CostControlModule,
    CustomerAlertsModule,
    AnalyticsModule,
    PaymentProvidersModule,
    TeamModule,
    WebhooksModule,
    SdkModule,
    PublicInvoiceModule,
    PortalSessionsModule,
    FiltersModule,
    PublicModule,
    PortalApiModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global exception filter. Must be the FIRST global filter so it sees every
    // unhandled exception before Nest's default exception filter swallows it.
    // Without this, controllers can throw all day and Sentry never captures
    // anything — the SDK is initialized and the interceptor stamps tags, but the
    // tags never apply because the events never reach Sentry.
    //
    // This is CustomerFailureAlertFilter,
    // which EXTENDS SentryGlobalFilter — it does everything Sentry's filter does
    // (it ALWAYS calls super.catch on every path, so captures never stop) and
    // ALSO fires customer-failure Slack alerts. It owns ALL the alerting
    // classes — 400/422/403/429 AND 401. CombinedAuthGuard records nothing, so
    // there's one recorder and no double-page. See the filter file for the two
    // invariants (always-super.catch, never-throw side-effect).
    {
      provide: APP_FILTER,
      useClass: CustomerFailureAlertFilter,
    },
    // Global JSON-nesting guard: a deep payload on any transform
    // route 400s here instead of stack-overflowing the ValidationPipe into a
    // 500. ORDERING FACT: ROOT-module APP_GUARDs run
    // BEFORE imported modules' — Nest scans the root first — so this guard runs
    // ahead of AuthModule's CombinedAuthGuard and request.user is NOT set here.
    // Harmless for THIS guard only because it never reads request.user (a deep
    // unauthenticated payload answers 400 instead of 401, which leaks nothing).
    // Any guard that DOES need request.user must register in auth.module.ts
    // AFTER CombinedAuthGuard. See PublishableKeyReadGuard there: a root-module
    // registration of it would fail open the entire API.
    {
      provide: APP_GUARD,
      useClass: JsonBodyDepthGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: PublishableKeyWriteGuardInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SentryContextInterceptor,
    },
  ],
})
export class AppModule {}
