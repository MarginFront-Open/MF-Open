import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueryServicePricingDto } from './dto';

@Injectable()
export class ServicePricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List entries from the global service_pricing catalog. Supports filters by
   * provider, serviceType, and isApi (boolean for LLM vs non-LLM split), plus a
   * case-insensitive search against canonicalName and displayName. Returns
   * paginated rows the SDK / MCP / dashboard can present so customers can
   * discover canonical names BEFORE firing usage events with unrecognized
   * model+provider combos.
   *
   * The catalog is global (not organization-scoped). The auth layer still
   * authenticates the caller; we just don't filter by organizationId here.
   */
  async listServices(query: QueryServicePricingDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.service_pricingWhereInput = {
      isActive: true,
    };

    if (query.provider) {
      where.provider = { equals: query.provider.toLowerCase(), mode: 'insensitive' };
    }
    if (query.serviceType) {
      where.serviceType = { equals: query.serviceType, mode: 'insensitive' };
    }
    if (typeof query.isApi === 'boolean') {
      where.isApi = query.isApi;
    }
    if (query.search) {
      where.OR = [
        { canonicalName: { contains: query.search, mode: 'insensitive' } },
        { displayName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.service_pricing.findMany({
        where,
        select: {
          id: true,
          externalId: true,
          canonicalName: true,
          displayName: true,
          provider: true,
          serviceType: true,
          inputCost: true,
          outputCost: true,
          costUnit: true,
          contextWindow: true,
          source: true,
          isApi: true,
          isActive: true,
        },
        orderBy: [{ provider: 'asc' }, { serviceType: 'asc' }, { canonicalName: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.service_pricing.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a single catalog entry by its UUID. Returns 404 if not found or inactive.
   */
  async getService(id: string) {
    const entry = await this.prisma.service_pricing.findFirst({
      where: { id, isActive: true },
      select: {
        id: true,
        externalId: true,
        canonicalName: true,
        displayName: true,
        provider: true,
        serviceType: true,
        inputCost: true,
        outputCost: true,
        costUnit: true,
        contextWindow: true,
        source: true,
        isApi: true,
        isActive: true,
      },
    });

    if (!entry) {
      throw new NotFoundException(`Service catalog entry not found: ${id}`);
    }

    return entry;
  }
}
