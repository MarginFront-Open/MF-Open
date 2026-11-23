import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GetFiltersDto } from './filters.dto';

@Injectable()
export class FiltersService {
  private readonly logger = new Logger(FiltersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getFilters(orgId: string, query: GetFiltersDto) {
    const {
      agentId,
      customerId,
      dataTypes = ['agents', 'customers', 'pricingPlans', 'signals', 'subscriptions'],
      sortBy,
      limit,
      page,
    } = query;

    const validDataTypes = ['agents', 'customers', 'pricingPlans', 'signals', 'subscriptions'];
    const requestedDataTypes = Array.isArray(dataTypes) ? dataTypes : [dataTypes];
    const filteredDataTypes = requestedDataTypes.filter((type) => validDataTypes.includes(type));

    if (filteredDataTypes.length === 0) {
      return {};
    }

    const take = limit ? parseInt(String(limit), 10) : undefined;
    const skip =
      page && limit ? (parseInt(String(page), 10) - 1) * parseInt(String(limit), 10) : undefined;

    let orderBy: any = undefined;
    if (sortBy) {
      const [field, order] = sortBy.split(':');
      if (field && ['asc', 'desc'].includes(order?.toLowerCase())) {
        orderBy = { [field]: order.toLowerCase() };
      }
    }

    const result: any = {};
    const fetchPromises: Promise<void>[] = [];

    if (filteredDataTypes.includes('agents')) {
      const agentPromise = this.prisma.agents
        .findMany({
          where: {
            orgId,
            ...(agentId && { id: agentId }),
          },
          select: {
            id: true,
            name: true,
            description: true,
            agentCode: true,
            isActive: true,
            pricing_plans: {
              select: {
                id: true,
                name: true,
                description: true,
                isActive: true,
              },
            },
          },
          ...(orderBy && { orderBy }),
          ...(take && { take }),
          ...(skip && { skip }),
        })
        .then((agents) => {
          result.agents = agents.map((agent) => ({
            ...agent,
            pricingPlans: agent.pricing_plans,
          }));
        })
        .catch((error) => {
          this.logger.error('Error fetching agents:', error);
          result.agents = [];
          result.errors = result.errors || {};
          result.errors.agents = error.message;
        });

      fetchPromises.push(agentPromise);
    }

    if (filteredDataTypes.includes('customers')) {
      let customerPromise: Promise<void>;

      if (agentId) {
        // Filter customers by subscriptions with that agent
        customerPromise = this.prisma.customers
          .findMany({
            where: {
              organizationId: orgId,
              ...(customerId && { id: customerId }),
              subscriptions: {
                some: { agentId },
              },
            },
            select: {
              id: true,
              name: true,
              email: true,
              externalId: true,
              status: true,
            },
            ...(orderBy && { orderBy }),
            ...(take && { take }),
            ...(skip && { skip }),
          })
          .then((customers) => {
            result.customers = customers || [];
          })
          .catch((error) => {
            this.logger.error('Error fetching customers with agent filter:', error);
            result.customers = [];
            result.errors = result.errors || {};
            result.errors.customers = error.message;
          });
      } else {
        customerPromise = this.prisma.customers
          .findMany({
            where: {
              organizationId: orgId,
              ...(customerId && { id: customerId }),
            },
            select: {
              id: true,
              name: true,
              email: true,
              externalId: true,
              status: true,
            },
            ...(orderBy && { orderBy }),
            ...(take && { take }),
            ...(skip && { skip }),
          })
          .then((customers) => {
            result.customers = customers || [];
          })
          .catch((error) => {
            this.logger.error('Error fetching customers:', error);
            result.customers = [];
            result.errors = result.errors || {};
            result.errors.customers = error.message;
          });
      }

      fetchPromises.push(customerPromise);
    }

    if (filteredDataTypes.includes('pricingPlans')) {
      const pricingPlanPromise = this.prisma.pricing_plans
        .findMany({
          where: {
            orgId,
            ...(agentId && { agentId }),
          },
          select: {
            id: true,
            name: true,
            description: true,
            featuresList: true,
            isActive: true,
          },
          ...(orderBy && { orderBy }),
          ...(take && { take }),
          ...(skip && { skip }),
        })
        .then((plans) => {
          result.pricingPlans = plans || [];
        })
        .catch((error) => {
          this.logger.error('Error fetching pricing plans:', error);
          result.pricingPlans = [];
          result.errors = result.errors || {};
          result.errors.pricingPlans = error.message;
        });

      fetchPromises.push(pricingPlanPromise);
    }

    if (filteredDataTypes.includes('signals')) {
      const signalPromise = this.prisma.signals
        .findMany({
          where: {
            orgId,
            ...(agentId && { agentId }),
          },
          select: {
            id: true,
            name: true,
            shortName: true,
            type: true,
          },
          ...(orderBy && { orderBy }),
          ...(take && { take }),
          ...(skip && { skip }),
        })
        .then((signals) => {
          result.signals = signals || [];
        })
        .catch((error) => {
          this.logger.error('Error fetching signals:', error);
          result.signals = [];
          result.errors = result.errors || {};
          result.errors.signals = error.message;
        });

      fetchPromises.push(signalPromise);
    }

    if (filteredDataTypes.includes('subscriptions')) {
      const subscriptionPromise = (async () => {
        try {
          // Resolve customer ids through the ORG-SCOPED customers table, with or
          // without a customerId. Taking the caller's `customerId` on trust would hand back another org's
          // subscription rows to anyone who passed their own org id in the URL — a hole the
          // route guard cannot close. Scoping the subscriptions query itself is NOT enough:
          // subscriptions.organizationId is nullable (packages/db/prisma/schema.prisma) so it
          // would silently drop rows with a null org, while customers.organizationId is non-null.
          const ownedCustomers = await this.prisma.customers.findMany({
            where: {
              organizationId: orgId,
              ...(customerId && { id: customerId }),
            },
            select: { id: true },
          });
          const customerIds = ownedCustomers.map((c) => c.id);

          const subscriptions = await this.prisma.subscriptions.findMany({
            where: {
              customerId: { in: customerIds },
              ...(agentId && { agentId }),
            },
            select: {
              id: true,
              name: true,
              status: true,
              startDate: true,
              endDate: true,
              planId: true,
              agentId: true,
              customerId: true,
              billingCycle: true,
            },
            ...(orderBy && { orderBy }),
            ...(take && { take }),
            ...(skip && { skip }),
          });

          result.subscriptions = subscriptions || [];
        } catch (error) {
          this.logger.error('Error fetching subscriptions:', error);
          result.subscriptions = [];
          result.errors = result.errors || {};
          result.errors.subscriptions = error.message;
        }
      })();

      fetchPromises.push(subscriptionPromise);
    }

    await Promise.all(fetchPromises);

    return result;
  }
}
