import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { PublicService } from './public.service';
import { Public } from '../auth/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';

/**
 * Public API Controller
 *
 * Unauthenticated endpoints for displaying pricing and organization info.
 * These are used by frontend SDKs with publishable keys or no auth at all.
 *
 * Rate limited per IP by the public throttler bucket.
 */
// Public bucket (60/60s per IP) — anonymous pricing/config lookups. Generous
// for a human browsing a pricing page; brutal for a script scraping.
@ApiTags('public')
@Controller('public')
@Public()
@Throttle({ public: { limit: 60, ttl: 60_000 } })
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  /**
   * Get public pricing information
   *
   * Returns pricing plans and strategies for an organization.
   * Use this to build pricing pages without authentication.
   */
  @Get('org/:slugOrId/pricing')
  @ApiOperation({
    summary: 'Get public pricing',
    description: `
Returns pricing plans for an organization. No authentication required.

**Use cases:**
- Display pricing on marketing pages
- Show plan options in checkout flows
- Build custom pricing tables

**Note:** Only returns active, non-deleted plans and strategies.
    `,
  })
  @ApiParam({
    name: 'slugOrId',
    description: 'Organization slug or UUID',
    examples: {
      slug: { value: 'acme-corp', summary: 'By slug' },
      uuid: {
        value: '550e8400-e29b-41d4-a716-446655440000',
        summary: 'By UUID',
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Pricing information retrieved successfully',
    schema: {
      example: {
        organization: {
          id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'Acme Corp',
          slug: 'acme-corp',
          logo: 'https://example.com/logo.png',
        },
        agents: [
          {
            id: 'agent_123',
            name: 'AI Assistant',
            description: 'Conversational AI agent',
            plans: [
              {
                id: 'plan_456',
                name: 'Starter',
                description: 'Perfect for small teams',
                isDefault: true,
                features: ['100 conversations/mo', 'Email support'],
                strategies: [
                  {
                    id: 'strat_789',
                    name: 'Monthly Subscription',
                    type: 'subscription',
                    basePrice: 29,
                    currency: 'USD',
                    billingInterval: 'month',
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  async getPricing(@Param('slugOrId') slugOrId: string) {
    return this.publicService.getPricing(slugOrId);
  }

  /**
   * Get public organization configuration
   *
   * Returns basic org info and feature flags for frontend configuration.
   */
  @Get('org/:slugOrId/config')
  @ApiOperation({
    summary: 'Get organization config',
    description: `
Returns organization configuration for frontend setup. No authentication required.

**Use cases:**
- Initialize SDK with org-specific settings
- Check which features are enabled
- Apply branding (logo, colors)

**Features flags:**
- \`pricing\`: Organization has agents with pricing plans
- \`checkout\`: Organization has payment provider configured
- \`portal\`: Customer portal is available (always true)
    `,
  })
  @ApiParam({
    name: 'slugOrId',
    description: 'Organization slug or UUID',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization config retrieved successfully',
    schema: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Acme Corp',
        slug: 'acme-corp',
        logo: 'https://example.com/logo.png',
        primaryColor: '#4F46E5',
        features: {
          pricing: true,
          checkout: true,
          portal: true,
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  async getOrgConfig(@Param('slugOrId') slugOrId: string) {
    return this.publicService.getOrgConfig(slugOrId);
  }
}
