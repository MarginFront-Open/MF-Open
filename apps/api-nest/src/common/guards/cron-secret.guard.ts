import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Scheduler endpoints accept `Authorization: Bearer <CRON_SECRET>` from any cron
 * service (Vercel Cron adds it itself). Routes behind this guard must also be
 * `@Public()`, because a scheduler's request carries no MarginFront API key.
 */
@Injectable()
export class CronSecretGuard implements CanActivate {
  private readonly logger = new Logger(CronSecretGuard.name);
  private readonly cronSecret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.cronSecret = this.configService.get<string>('CRON_SECRET')?.trim() || undefined;
    if (!this.cronSecret) {
      this.logger.warn(
        'CRON_SECRET env var is not set. All cron endpoint requests will be rejected.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.cronSecret) {
      throw new UnauthorizedException('Cron secret not configured on server');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = (request.headers['authorization'] ?? '') as string;
    const expected = `Bearer ${this.cronSecret}`;

    // Padding keeps the compare constant-time; without the length check the right
    // secret with extra characters appended would pass.
    const expectedBuf = Buffer.from(expected);
    const rawBuf = Buffer.from(authHeader);
    const actualBuf = Buffer.alloc(expectedBuf.length);
    rawBuf.copy(actualBuf);
    const sameLength = rawBuf.length === expectedBuf.length;

    if (!timingSafeEqual(actualBuf, expectedBuf) || !sameLength) {
      this.logger.warn(
        'Cron endpoint hit with missing or incorrect Authorization header — request rejected',
      );
      throw new UnauthorizedException('Invalid cron secret');
    }

    return true;
  }
}
