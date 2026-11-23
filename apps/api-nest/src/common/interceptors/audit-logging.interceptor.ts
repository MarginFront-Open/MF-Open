import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Global interceptor that writes one row to api_key_usage_logs for every
 * API-key-authenticated request.
 *
 * Design choices:
 *   - Listens on response 'finish' event instead of RxJS tap/finalize, so
 *     the status code is guaranteed to be final (exception filters have
 *     already run by the time 'finish' fires).
 *   - All audit failures are swallowed — a broken audit write must NEVER
 *     affect a real customer request.
 *   - Only logs authMethod === 'api-key' requests. Session/JWT requests
 *     from the dashboard are not audited here.
 */
@Injectable()
export class AuditLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLoggingInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const requestTime = new Date();

    response.on('finish', () => {
      this.writeAuditLog(request, response, requestTime).catch((err) => {
        this.logger.warn(`audit log write failed (swallowed): ${err?.message || 'unknown error'}`);
      });
    });

    return next.handle();
  }

  private async writeAuditLog(request: any, response: any, requestTime: Date): Promise<void> {
    const user = request.user;

    if (!user || user.authMethod !== 'api-key' || !user.apiKeyId || !user.organizationId) {
      return;
    }

    const method = request.method || 'UNKNOWN';
    const rawUrl = request.originalUrl || request.url || '';
    const urlNoQuery = rawUrl.split('?')[0];
    const endpoint = `${method} ${urlNoQuery}`.substring(0, 255);

    const forwardedFor = request.headers?.['x-forwarded-for'];
    const ipRaw =
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) ||
      request.ip ||
      request.socket?.remoteAddress ||
      null;
    const ipAddress = ipRaw ? String(ipRaw).substring(0, 255) : null;

    const now = new Date();

    await this.prisma.api_key_usage_logs.create({
      data: {
        id: randomUUID(),
        apiKeyId: user.apiKeyId,
        organizationId: user.organizationId,
        requestTime,
        ipAddress,
        endpoint,
        responseStatus: response?.statusCode ?? null,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    });
  }
}
