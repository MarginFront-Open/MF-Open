import { Module } from '@nestjs/common';
import { PortalApiController } from './portal-api.controller';
import { PortalApiService } from './portal-api.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';

/**
 * Portal API Module
 *
 * Provides customer-facing endpoints accessed via portal session tokens.
 * These endpoints allow customers to view and manage their billing data
 * without exposing the organization's API key.
 *
 * Endpoints:
 * - GET /portal/session - Current session info
 * - GET /portal/profile - Customer profile
 * - PATCH /portal/profile - Update profile
 * - GET /portal/invoices - List invoices
 * - GET /portal/invoices/:id - Get invoice
 * - GET /portal/subscriptions - List subscriptions
 * - GET /portal/usage - Activity summary (quantities only, no cost)
 *
 * All endpoints require a valid portal session token (prtl_*).
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PortalApiController],
  providers: [PortalApiService, RevenueMetricsService],
  exports: [PortalApiService],
})
export class PortalApiModule {}
