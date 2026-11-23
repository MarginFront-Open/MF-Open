import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject } from 'class-validator';

export class CalculateInvoiceDto {
  @ApiProperty({ description: 'Subscription ID' })
  @IsString()
  subscriptionId: string;

  @ApiPropertyOptional({ description: 'Custom start date for calculation' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Custom end date for calculation' })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Billing period start date' })
  @IsOptional()
  billingPeriodStart?: Date;

  @ApiPropertyOptional({ description: 'Billing period end date' })
  @IsOptional()
  billingPeriodEnd?: Date;

  @ApiPropertyOptional({ description: 'Invoice type' })
  @IsOptional()
  @IsString()
  invoiceType?: string;

  @ApiPropertyOptional({ description: 'Transaction context' })
  @IsOptional()
  transaction?: any;

  @ApiPropertyOptional({ description: 'Additional parameters', type: 'object' })
  @IsOptional()
  @IsObject()
  params?: Record<string, any>;
}

export class SimulateRevenueDto {
  @ApiProperty({ description: 'Pricing plan ID' })
  @IsString()
  pricingPlanId: string;

  @ApiPropertyOptional({ description: 'Projected events with counts', type: 'object' })
  @IsOptional()
  @IsObject()
  projectedEvents?: Record<string, number>;

  @ApiPropertyOptional({ description: 'Billing cycle', enum: ['monthly', 'yearly'] })
  @IsOptional()
  @IsString()
  billingCycle?: string;

  @ApiPropertyOptional({ description: 'Number of seats' })
  @IsOptional()
  seatsCount?: number;
}
