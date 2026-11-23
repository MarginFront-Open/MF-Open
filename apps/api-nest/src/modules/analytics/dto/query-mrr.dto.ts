import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

/**
 * MRR variant selector for `GET /v1/analytics/mrr`.
 *
 * canonical (MRR1). "current contracted recurring value per month"
 * runRate (MRR2). "trajectory if current 30-day pace continues"
 * committed (MRR3). "contractual floor regardless of usage"
 * all. Returns all three in one response shape
 */
export enum MrrVariantEnum {
  CANONICAL = 'canonical',
  RUN_RATE = 'runRate',
  COMMITTED = 'committed',
  ALL = 'all',
}

export class QueryMrrDto {
  @ApiProperty({
    description: 'MRR variant to return',
    enum: MrrVariantEnum,
    default: MrrVariantEnum.CANONICAL,
    required: false,
  })
  @IsEnum(MrrVariantEnum)
  @IsOptional()
  variant?: MrrVariantEnum = MrrVariantEnum.CANONICAL;

  @ApiProperty({ description: 'Filter by customer ID', required: false })
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiProperty({ description: 'Filter by subscription ID', required: false })
  @IsUUID()
  @IsOptional()
  subscriptionId?: string;
}
