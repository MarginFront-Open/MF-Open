import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { ServicePricingService } from './service-pricing.service';
import { QueryServicePricingDto } from './dto';

// Canonical:    /v1/services
// Alias:        /v1/org/:orgId/services  (kept for symmetry with the rest of
// the API; orgId is ignored because the catalog is global, not org-scoped)
//
// Read-only. The catalog is populated by packages/db/scripts/sync-service-pricing.ts
// from OpenRouter + LiteLLM + built-in rows. Callers can discover canonical
// names here BEFORE firing usage events to avoid NEEDS_COST_BACKFILL on first hit.
@ApiTags('services')
@Controller()
@ApiBearerAuth()
@ApiSecurity('api-key')
export class ServicePricingController {
  constructor(private readonly servicePricingService: ServicePricingService) {}

  @Get(['services', 'org/:orgId/services'])
  @ApiOperation({
    summary: 'List entries from the global service catalog',
    description:
      'Returns paginated entries from the service_pricing catalog. Use this to discover ' +
      'the canonical model + modelProvider names MarginFront recognizes for cost calculation. ' +
      'Filterable by provider, serviceType, isApi (LLM vs non-LLM), and full-text search.',
  })
  @ApiResponse({ status: 200, description: 'Catalog entries retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listServices(@Query() query: QueryServicePricingDto) {
    return this.servicePricingService.listServices(query);
  }

  @Get(['services/:serviceId', 'org/:orgId/services/:serviceId'])
  @ApiOperation({ summary: 'Get a specific catalog entry by ID' })
  @ApiResponse({ status: 200, description: 'Catalog entry retrieved' })
  @ApiResponse({ status: 404, description: 'Catalog entry not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getService(@Param('serviceId') serviceId: string) {
    return this.servicePricingService.getService(serviceId);
  }
}
