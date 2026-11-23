/**
 * Utility functions for usage data aggregation
 */
import { PrismaClient } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createDateRangeFilter } from '../date/date.utils';
import { parseNumericValue } from '../format/format.utils';

export interface AggregatedUsage {
  totalQuantity: number;
  totalUsageCost: number;
  signalId: string;
  signalName: string;
}

/**
 * Aggregate usage data for a specific period and customer
 * @param params - Parameters for aggregation
 * @param prisma - Prisma client instance
 * @returns Aggregated usage data by signal type
 */
export const aggregateUsage = async (
  params: {
    customerId?: string;
    agentId: string;
    periodStart: string;
    periodEnd: string;
    customerExternalId?: string;
    transaction?: PrismaClient;
  },
  prisma: PrismaClient,
): Promise<Record<string, AggregatedUsage>> => {
  const { customerId, agentId, periodStart, periodEnd, customerExternalId, transaction } = params;

  let customerExtId = customerExternalId;
  const client = transaction || prisma;

  if (!customerExternalId && customerId) {
    const customer = await client.customers.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    customerExtId = customer.externalId;
  } else if (!customerExternalId && !customerId) {
    throw new BadRequestException('Either customerId or customerExternalId is required');
  }

  const dateFilter = createDateRangeFilter(periodStart, periodEnd, 'usageDate');

  const signalEvents = await client.signal_events.findMany({
    where: {
      customerExternalId: customerExtId,
      agentId,
      ...dateFilter,
    },
    include: {
      signals: true,
    },
  });

  const aggregatedUsage: Record<string, AggregatedUsage> = {};

  signalEvents.forEach((event) => {
    const signalName = event.signals.shortName;

    if (!aggregatedUsage[signalName]) {
      aggregatedUsage[signalName] = {
        totalQuantity: 0,
        totalUsageCost: 0,
        signalId: event.signalId,
        signalName: event.signals.name,
      };
    }

    aggregatedUsage[signalName].totalQuantity += parseNumericValue(event.quantity);
    aggregatedUsage[signalName].totalUsageCost += parseNumericValue(event.usageCost);
  });

  return aggregatedUsage;
};
