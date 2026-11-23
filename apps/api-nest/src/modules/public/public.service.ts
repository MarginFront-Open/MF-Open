import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Public pricing plan response
 */
export interface PublicPricingPlan {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  features?: string[];
  strategies: {
    id: string;
    name: string;
    type: string;
    basePrice?: number;
    pricePerUnit?: number;
    currency: string;
    billingInterval?: string;
    includedUnits?: number;
    tiers?: any[];
  }[];
}

/**
 * Public agent response
 */
export interface PublicAgent {
  id: string;
  name: string;
  description?: string;
  plans: PublicPricingPlan[];
}

/**
 * Public pricing response
 */
export interface PublicPricingResponse {
  organization: {
    id: string;
    name: string;
    slug?: string;
    logo?: string;
  };
  agents: PublicAgent[];
}

/**
 * Public org config response
 */
export interface PublicOrgConfigResponse {
  id: string;
  name: string;
  slug?: string;
  logo?: string;
  primaryColor?: string;
  features: {
    pricing: boolean;
    checkout: boolean;
    portal: boolean;
  };
}

@Injectable()
export class PublicService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find organization by ID or slug
   */
  private async findOrganization(slugOrId: string) {
    // Try by ID first (UUID format)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);

    if (isUuid) {
      return this.prisma.organizations.findUnique({
        where: { id: slugOrId },
      });
    }

    // Try by slug
    return this.prisma.organizations.findFirst({
      where: { slug: slugOrId },
    });
  }

  /**
   * Get public pricing information for an organization
   *
   * This endpoint is unauthenticated and returns pricing plans
   * that can be displayed on pricing pages.
   */
  async getPricing(slugOrId: string): Promise<PublicPricingResponse> {
    const organization = await this.findOrganization(slugOrId);

    if (!organization) {
      throw new NotFoundException(`Organization not found: ${slugOrId}`);
    }

    // Get all agents with their pricing plans and strategies
    const agents = await this.prisma.agents.findMany({
      where: {
        orgId: organization.id,
        deletedAt: null,
      },
      include: {
        pricing_plans: {
          where: {
            deletedAt: null,
          },
          include: {
            pricing_strategies: {
              where: {
                deletedAt: null,
              },
              orderBy: {
                createdAt: 'asc',
              },
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return {
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug || undefined,
        logo: organization.logo || undefined,
      },
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description || undefined,
        plans: agent.pricing_plans.map((plan) => ({
          id: plan.id,
          name: plan.name,
          description: plan.description || undefined,
          isDefault: false, // Pricing plans don't have isDefault field
          features: (plan.featuresList as string[]) || [],
          strategies: plan.pricing_strategies.map((strategy) => ({
            id: strategy.id,
            name: strategy.name,
            type: strategy.pricingType,
            basePrice: strategy.basePrice ? parseFloat(strategy.basePrice.toString()) : undefined,
            pricePerUnit: strategy.pricePerUnit
              ? parseFloat(strategy.pricePerUnit.toString())
              : undefined,
            currency: strategy.currency || 'USD',
            billingInterval: strategy.billingInterval || undefined,
            includedUnits: strategy.includedUnits || undefined,
            tiers: strategy.tiers || undefined,
          })),
        })),
      })),
    };
  }

  /**
   * Get public organization configuration
   *
   * Returns basic org info and feature flags for frontend configuration.
   */
  async getOrgConfig(slugOrId: string): Promise<PublicOrgConfigResponse> {
    const organization = await this.findOrganization(slugOrId);

    if (!organization) {
      throw new NotFoundException(`Organization not found: ${slugOrId}`);
    }

    // Check which features are enabled for this org
    const [hasAgents, hasPaymentProvider] = await Promise.all([
      this.prisma.agents.count({
        where: { orgId: organization.id, deletedAt: null },
      }),
      this.prisma.payment_providers.count({
        where: { organization_id: organization.id, is_active: true },
      }),
    ]);

    // Extract primary color from designjson if available
    const designJson = organization.designjson as Record<string, any> | null;
    const primaryColor = designJson?.headerColor || designJson?.primaryColor;

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug || undefined,
      logo: organization.logo || undefined,
      primaryColor: primaryColor || undefined,
      features: {
        pricing: hasAgents > 0,
        checkout: hasPaymentProvider > 0,
        portal: true, // Portal always available
      },
    };
  }
}
