import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/**
 * The accounting buckets a signal can map to. Mirrors the Prisma enum
 * `enum_signals_costCategory` exactly (see packages/db/prisma/schema.prisma).
 *
 *   PRODUCTION_COGS — Production inference / serving. Article: COGS, ASC 730.
 *   DEVELOPMENT_RD  — Dev/test inference, training, fine-tuning. R&D OpEx.
 *   SALES_SM        — Sales & marketing AI usage (sales agents, outbound,
 *                     CRM, content gen). S&M OpEx, below gross margin.
 *   GENERAL_GA      — General & administrative AI usage (finance, legal, HR,
 *                     exec). G&A OpEx, below gross margin.
 *   INTERNAL_TOOL   — Internal-use AI (e.g. an internal copilot). Hybrid:
 *                     classified by department; ASC 350-40 may allow
 *                     capitalization in some cases.
 *   UNCLASSIFIED    — Default; no bucket asserted yet.
 */
export const SIGNAL_COST_CATEGORIES = [
  'PRODUCTION_COGS',
  'DEVELOPMENT_RD',
  'SALES_SM',
  'GENERAL_GA',
  'INTERNAL_TOOL',
  'UNCLASSIFIED',
] as const;
export type SignalCostCategory = (typeof SIGNAL_COST_CATEGORIES)[number];

export class ClassifySignalDto {
  @ApiProperty({
    description:
      "Accounting bucket the signal's cost should flow into. Drives the " +
      'COGS vs R&D split on the Cost Management dashboard and any GL ' +
      'exports built on top of the canonical cost-metrics breakdown.',
    enum: SIGNAL_COST_CATEGORIES,
  })
  @IsIn(SIGNAL_COST_CATEGORIES as unknown as string[])
  costCategory: SignalCostCategory;
}
