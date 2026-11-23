import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PortalSessionsService } from './portal-sessions.service';
import { PortalSessionsController } from './portal-sessions.controller';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Portal Sessions Module
 *
 * Provides API endpoints for creating and managing portal sessions.
 * Portal sessions allow customers to securely access their billing data
 * without exposing the organization's API key.
 *
 * This follows the industry standard pattern (Stripe, Chargebee):
 * - Backend creates session with secret key
 * - Frontend/customer uses the session URL/token
 * - Sessions expire after 1 hour
 */
@Module({
  imports: [PrismaModule, AuthModule, ConfigModule],
  controllers: [PortalSessionsController],
  providers: [PortalSessionsService],
  exports: [PortalSessionsService],
})
export class PortalSessionsModule {}
