import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { PrismaModule } from '../../common/prisma/prisma.module';

/**
 * Public Module
 *
 * Provides unauthenticated endpoints for public information:
 * - Pricing plans display
 * - Organization configuration
 *
 * These endpoints are rate-limited per IP by the public throttler
 * bucket and do not require API keys or authentication.
 *
 * Use cases:
 * - Marketing pages showing pricing
 * - SDK initialization
 * - Public embeds
 */
@Module({
  imports: [PrismaModule],
  controllers: [PublicController],
  providers: [PublicService],
  exports: [PublicService],
})
export class PublicModule {}
