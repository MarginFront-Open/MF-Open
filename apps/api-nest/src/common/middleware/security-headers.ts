import helmet from 'helmet';
import type { RequestHandler } from 'express';

/**
 * helmet security headers on every request EXCEPT the Swagger UI paths, whose inline
 * assets need a looser policy.
 *
 * Lives outside main.ts so BOTH bootstraps, standalone and serverless, apply the exact
 * same headers. Putting helmet inside main.ts's standalone-only `if (!expressInstance)`
 * branch would leave a serverless deployment with NO security headers at all.
 * Keeping it here also makes the middleware unit-testable without booting the app.
 */
export function securityHeadersMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (req.path.startsWith('/api-docs')) {
      return next();
    }
    return helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
      crossOriginEmbedderPolicy: false,
    })(req, res, next);
  };
}
