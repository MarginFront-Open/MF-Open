import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  IsDate,
  IsBoolean,
  IsOptional,
  IsIn,
  IsNumber,
  IsObject,
  Min,
  Max,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { Type } from 'class-transformer';

// Billing anchors: the three dates that fix which usage the billing cron sweeps
// into each invoice window. They are set once at creation and are immutable after.
// Moving them on a live subscription re-bills or orphans usage events, because the
// dispatch cron selects events by period (dispatchUsageInvoices in
// subscription-billing.service.ts).
export const BILLING_ANCHOR_FIELDS = [
  'startDate',
  'currentBillingPeriodStart',
  'currentBillingPeriodEnd',
] as const;

export function submittedBillingAnchors(payload: Record<string, unknown>): string[] {
  return BILLING_ANCHOR_FIELDS.filter(
    (field) => payload[field] !== undefined && payload[field] !== null,
  );
}

export function billingAnchorImmutableMessage(submittedFields: string[]): string {
  const list = submittedFields.join(', ');
  return (
    `Billing anchors cannot be changed after a subscription is created: ${list}. ` +
    `These dates define which usage the billing cron sweeps into each invoice, so moving ` +
    `them on a live subscription would double-bill or orphan usage events. To bill on a ` +
    `different schedule, create a new subscription anchored to the dates you want.`
  );
}

// Class-level guard (mirrors IsExactlyOneShape in record-usage.dto.ts): the global
// pipe runs whitelist:false, so an undeclared billing-anchor field would otherwise ride
// onto the DTO and be silently dropped by the service. This rejects the request instead.
function RejectsBillingAnchorMutation(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'rejectsBillingAnchorMutation',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          return submittedBillingAnchors(args.object as Record<string, unknown>).length === 0;
        },
        defaultMessage(args: ValidationArguments) {
          return billingAnchorImmutableMessage(
            submittedBillingAnchors(args.object as Record<string, unknown>),
          );
        },
      },
    });
  };
}

export class UpdateSubscriptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  planId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endDate?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isForever?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  subscriptionDetails?: any;

  @ApiPropertyOptional({ enum: ['monthly', 'yearly', 'custom'] })
  @IsOptional()
  @IsIn(['monthly', 'yearly', 'custom'])
  billingCycle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  customCycleDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  proratedAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  billingDay?: number;

  @ApiPropertyOptional({ enum: ['active', 'pending', 'upcoming', 'expired', 'canceled', 'ended'] })
  @IsOptional()
  @IsIn(['active', 'pending', 'upcoming', 'expired', 'canceled', 'ended'])
  status?: string;

  @ApiPropertyOptional({ enum: ['subscription', 'usage', 'hybrid'] })
  @IsOptional()
  @IsIn(['subscription', 'usage', 'hybrid'])
  billingModel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  netTerms?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoCollectPayment?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  invoiceMemo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: any;

  @ApiProperty()
  @IsString()
  changeReason: string;

  // Sentinel for the class-level billing-anchor guard. Never sent by
  // callers; its only job is to trigger RejectsBillingAnchorMutation during validation
  // so a PATCH carrying startDate / currentBillingPeriodStart / currentBillingPeriodEnd
  // is rejected with one clear message instead of silently dropped by the service.
  @RejectsBillingAnchorMutation()
  protected readonly __billingAnchorSentinel?: never;
}

export class UpdateInvoiceDatesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  subscriptionInvoiceIssuanceDate?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  billingDay?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endDate?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isForever?: boolean;

  @ApiProperty()
  @IsString()
  changeReason: string;
}
