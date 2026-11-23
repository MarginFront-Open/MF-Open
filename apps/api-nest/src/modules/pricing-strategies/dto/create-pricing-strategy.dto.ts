import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNotEmpty,
  MaxLength,
  IsUUID,
  IsEnum,
  IsNumber,
  IsArray,
  IsObject,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum ChargeType {
  USAGE = 'usage',
  RECURRING = 'recurring',
  ONETIME = 'onetime',
  SEAT_BASED = 'seat_based',
}

export enum PricingModel {
  FLAT = 'flat',
  GRADUATED = 'graduated',
  VOLUME = 'volume',
  CREDIT_POOL = 'credit_pool',
}

export enum BillingFrequency {
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
  QUARTERLY = 'quarterly',
  WEEKLY = 'weekly',
}

// Tier needs to be a real class (not just a TypeScript type) so that
// class-transformer knows how to build it from the incoming JSON.
// Without this, tiers arrive as empty arrays and your prices vanish.
export class PricingTierDto {
  @IsNumber()
  lower: number;

  @IsNumber()
  @IsOptional()
  upper: number | null;

  @IsNumber()
  rate: number;
}

// The credit-pool shortcut: in the raw tiers array tiers[0].rate is
// a FLAT pool fee while tiers[1].rate is per-unit, and nobody guesses that right.
// A real class for the same reason PricingTierDto is — class-transformer
// silently empties an untyped nested object, so every field referencing this
// needs @Type(() => CreditPoolInputDto).
export class CreditPoolInputDto {
  @ApiProperty({
    description: 'How many units the pool covers each billing cycle',
    example: 5000,
  })
  @IsNumber()
  @Min(0)
  poolSize: number;

  @ApiProperty({
    description: 'Flat fee charged every cycle for the pool, used or not',
    example: 99,
  })
  @IsNumber()
  @Min(0)
  poolPrice: number;

  @ApiProperty({
    description: 'Per-unit price for usage beyond the pool',
    example: 0.03,
  })
  @IsNumber()
  @Min(0)
  overageRate: number;
}

export class CreatePricingStrategyDto {
  @ApiProperty({
    description: 'Pricing strategy name',
    example: 'API Calls - Tiered Pricing',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    description: 'Agent ID this strategy belongs to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  agentId: string;

  @ApiPropertyOptional({
    description: 'Signal ID for usage-based charging',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsOptional()
  signalId?: string;

  @ApiPropertyOptional({
    description: 'Tags for categorization',
    example: ['api', 'premium'],
  })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiProperty({
    description: 'Charge type',
    enum: ChargeType,
    example: ChargeType.USAGE,
  })
  @IsEnum(ChargeType)
  @IsNotEmpty()
  chargeType: ChargeType;

  @ApiPropertyOptional({
    description: 'Pricing model',
    enum: PricingModel,
    example: PricingModel.GRADUATED,
  })
  @IsEnum(PricingModel)
  @IsOptional()
  pricingModel?: PricingModel;

  @ApiPropertyOptional({
    description: 'Billing frequency',
    enum: BillingFrequency,
    example: BillingFrequency.MONTHLY,
  })
  @IsEnum(BillingFrequency)
  @IsOptional()
  billingFrequency?: BillingFrequency;

  @ApiPropertyOptional({
    description: 'Tier configuration for tiered/volume pricing',
    example: [
      { lower: 0, upper: 1000, rate: 0.01 },
      { lower: 1001, upper: 10000, rate: 0.008 },
      { lower: 10001, upper: null, rate: 0.005 },
    ],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PricingTierDto)
  tiers?: PricingTierDto[];

  @ApiPropertyOptional({
    description:
      'Credit-pool shortcut. Compiled server-side into the two-tier shape, so you never ' +
      'hand-build it. Only valid when pricingModel is credit_pool.',
    type: CreditPoolInputDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreditPoolInputDto)
  creditPool?: CreditPoolInputDto;

  @ApiPropertyOptional({
    description:
      'Per-metric burn rates for a credit pool: {signalId: creditsPerUnit}. ' +
      'The pool draws for its own signal plus every key here; a missing key on the ' +
      "pool's own signal means 1. Values must be numbers greater than zero — to make " +
      'a metric free, leave it out. Send {} to clear all rates; null or omitted ' +
      'leaves them unchanged. Only valid when pricingModel is credit_pool.',
    example: { '123e4567-e89b-12d3-a456-426614174000': 4 },
  })
  @IsObject()
  @IsOptional()
  creditRates?: Record<string, number>;

  @ApiPropertyOptional({
    description: 'Flat rate (for flat pricing model)',
    example: 99.99,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  rate?: number;

  @ApiPropertyOptional({
    description: 'Whether the strategy is active',
    example: true,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  active?: boolean;

  @ApiPropertyOptional({
    description: 'Minimum commitment (for recurring charges)',
    example: 100,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  minimumCommitment?: number;
}
