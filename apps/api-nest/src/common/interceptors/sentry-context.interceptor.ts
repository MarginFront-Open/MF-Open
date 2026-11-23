import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import * as Sentry from '@sentry/nestjs';
import { detectSource } from '../../lib/request-source';

/**
 * Stamps the current request's Sentry scope with user identity (so an error
 * report shows who hit it) and a `source` tag (so it shows whether the call
 * came via SDK / dashboard / MCP / raw API).
 *
 * Pulled from the already-authenticated `request.user` (set by the auth
 * guard/middleware) plus the User-Agent header. Does nothing if the request
 * isn't authenticated — Sentry events from public/portal routes stay
 * anonymous.
 *
 * Per-request scope isolation is handled by SentryModule's
 * async-local-storage, so user A's identity will not bleed into user B's
 * events.
 */
@Injectable()
export class SentryContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const user = req?.user;

    Sentry.setTag('source', detectSource(req?.headers?.['user-agent']));

    if (user?.id) {
      Sentry.setUser({
        id: user.id,
        email: user.email,
      });
    }

    if (user?.organizationId) {
      Sentry.setTag('organization_id', user.organizationId);
      Sentry.setTag('organization_name', user.organizationName ?? '(unknown)');
    }

    return next.handle();
  }
}
