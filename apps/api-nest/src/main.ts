// Loads apps/api-nest/.env before instrument.ts reads SENTRY_DSN, which happens
// before Nest's ConfigModule has loaded the file.
import 'dotenv/config';
import './instrument';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, INestApplication } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';
import { buildTrustedOrigins } from './common/utils/cors';
import { ingestBodyParsers, INGEST_PATHS } from './common/utils/ingest-body-limit';
import { securityHeadersMiddleware } from './common/middleware/security-headers';

// Find swagger-ui-dist path
function findSwaggerUiPath(): string {
  const possiblePaths = [
    path.join(process.cwd(), 'node_modules', 'swagger-ui-dist'),
    path.join(process.cwd(), '..', '..', 'node_modules', 'swagger-ui-dist'),
    path.join(__dirname, '..', 'node_modules', 'swagger-ui-dist'),
    path.join(__dirname, '..', '..', '..', 'node_modules', 'swagger-ui-dist'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error('swagger-ui-dist not found');
}

const isServerless = process.env.VERCEL === '1' || process.env.AWS_LAMBDA_FUNCTION_NAME;

const server = express();
// Trust Vercel / load-balancer proxy so req.ip and req.ips reflect the real
// client IP from x-forwarded-for. Required for per-IP rate limiting to work
// on Vercel serverless — without this, all requests look like they come from
// the Vercel proxy IP and one user exhausts the public bucket for everyone.
server.set('trust proxy', 1);

async function createApp(expressInstance?: express.Express): Promise<INestApplication> {
  let app: NestExpressApplication;

  if (expressInstance) {
    const adapter = new ExpressAdapter(expressInstance);
    app = await NestFactory.create<NestExpressApplication>(AppModule, adapter, {
      logger: ['error', 'warn', 'log'],
      rawBody: true,
    });
  } else {
    // LOG_LEVEL=debug adds debug and verbose output, including every query.
    const logLevel = process.env.LOG_LEVEL || 'standard';
    const logLevels =
      logLevel === 'debug'
        ? ['error', 'warn', 'log', 'debug', 'verbose']
        : ['error', 'warn', 'log'];

    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: logLevels as any,
      rawBody: true,
    });
    // Same trust-proxy reasoning as serverless: behind a reverse proxy (e.g.
    // local nginx, Docker host), req.ip should reflect the client IP, not the
    // proxy's.
    (app.getHttpAdapter().getInstance() as express.Express).set('trust proxy', 1);
  }

  const configService = app.get(ConfigService);

  // Security headers (helmet) on every request except Swagger. Applied in BOTH
  // standalone and serverless modes.
  app.use(securityHeadersMiddleware());

  // CORS strategy:
  // - Trusted origins (dashboard): Allow credentials (cookies) for session-based auth
  // - Untrusted origins (SDK): Allow requests with API key auth, NO credentials
  // This prevents CSRF attacks while allowing SDK to work from any customer website
  const corsOrigins = configService.get('CORS_ORIGIN')?.split(',') || [];
  const trustedOrigins = buildTrustedOrigins(corsOrigins);

  // Custom CORS middleware to handle credentials dynamically
  // This is more secure than NestJS's enableCors() which sets credentials globally
  const allowedHeaders = [
    'Content-Type',
    'Authorization',
    'Accept',
    'Accept-Version',
    'Content-Length',
    'Content-MD5',
    'Date',
    'X-Api-Version',
    'X-API-Key',
    'x-api-key',
    'X-Request-ID',
    'x-request-id',
    'X-CSRF-Token',
    'X-Requested-With',
  ];
  const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // CRITICAL: Only allow credentials for trusted origins (prevents CSRF)
      if (trustedOrigins.isTrusted(origin)) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } else {
      // No origin (same-origin, curl, mobile apps) - allow all
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
      res.status(204).end();
      return;
    }

    next();
  });

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

  const apiPrefix = configService.get('API_PREFIX') || 'v1';
  app.setGlobalPrefix(apiPrefix, {
    exclude: ['api-docs', 'api-docs/(.*)', 'api-docs-json', 'health'],
  });

  // Raw body parsing for Stripe webhooks
  if (expressInstance) {
    expressInstance.use('/v1/webhooks/stripe', express.raw({ type: 'application/json' }));
  } else {
    app.use('/v1/webhooks/stripe', express.raw({ type: 'application/json' }));
  }

  // Body caps for the usage-ingest doors. Must mount before init:
  // Nest registers its default parsers there, and these paths must parse HERE
  // (2mb cap + nesting guard) so the default 100kb parser skips them.
  if (expressInstance) {
    expressInstance.use(INGEST_PATHS, ...ingestBodyParsers());
  } else {
    app.use(INGEST_PATHS, ...ingestBodyParsers());
  }

  // Swagger setup (standalone mode only)
  if (!expressInstance) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('MarginFront API')
      .setDescription('MarginFront Platform API Documentation')
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    SwaggerModule.setup('api-docs', app, document, {
      customCssUrl: '/swagger-assets/swagger-ui.css',
      customJs: [
        '/swagger-assets/swagger-ui-bundle.js',
        '/swagger-assets/swagger-ui-standalone-preset.js',
      ],
      swaggerOptions: {
        persistAuthorization: true,
      },
    });

    try {
      const swaggerUiPath = findSwaggerUiPath();
      console.log(`📦 Swagger UI assets path: ${swaggerUiPath}`);
      app.use('/swagger-assets', express.static(swaggerUiPath));
    } catch (err) {
      console.warn('⚠️ Could not find swagger-ui-dist, Swagger UI static assets may not load');
    }
  }

  return app;
}

async function bootstrap() {
  const app = await createApp();
  const configService = app.get(ConfigService);
  const port = configService.get('PORT') || 4000;

  await app.listen(port);

  console.log(`🚀 MarginFront NestJS API running on: http://localhost:${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/api-docs`);
  console.log(`🔍 Health Check: http://localhost:${port}/health`);
}

/**
 * Concurrency: the actual init work runs inside a single shared promise. Every
 * call returns that same promise, so two concurrent callers can never start two
 * NestFactory.create() invocations against the same Express instance.
 *
 * Why this matters: if two callers reach getServerlessApp() before init
 * finishes, without the shared promise both would see no app yet and run
 * NestFactory.create() twice on the same Express server, binding the request handler to provider instances whose
 * onModuleInit hasn't finished (for example CryptoService.key undefined inside
 * decrypt, or PerTenantThrottlerGuard.throttlers not iterable).
 *
 * Failure recovery: if the IIFE rejects, reset initPromise so the next
 * request triggers a fresh attempt rather than locking onto a permanently
 * rejected promise (a poisoned container that 500s every request until it
 * cycles).
 */
let initPromise: Promise<INestApplication> | null = null;

async function getServerlessApp(): Promise<INestApplication> {
  if (!initPromise) {
    initPromise = (async () => {
      const app = await createApp(server);
      await app.init();
      console.log('NestJS app initialized for serverless');
      return app;
    })().catch((err) => {
      console.error('Failed to initialize NestJS:', err);
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

if (isServerless) {
  // Serverless: nothing to do at module load. api/index.js awaits
  // getServerlessApp() on the first request, which kicks off (single-flight)
  // init. A fire-and-forget init call here would race that one and double-init
  // — see the getServerlessApp() block comment above.
} else {
  bootstrap();
}

export default server;
export { getServerlessApp };
