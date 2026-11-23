import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsBoolean, IsInt, Min, Max, IsIn, IsEnum } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ChargeType, PricingModel } from './create-pricing-strategy.dto';

export class QueryPricingStrategyDto {
  @ApiPropertyOptional({
    description: 'Filter by strategy name',
    example: 'API Calls',
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Filter by charge type',
    enum: ChargeType,
    example: ChargeType.USAGE,
  })
  @IsEnum(ChargeType)
  @IsOptional()
  chargeType?: ChargeType;

  @ApiPropertyOptional({
    description: 'Filter by pricing model',
    enum: PricingModel,
    example: PricingModel.GRADUATED,
  })
  @IsEnum(PricingModel)
  @IsOptional()
  pricingModel?: PricingModel;

  @ApiPropertyOptional({
    description: 'Filter by active status',
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  active?: boolean;

  @ApiPropertyOptional({
    description: 'Sort by field',
    example: 'createdAt',
    enum: ['name', 'chargeType', 'createdAt', 'updatedAt'],
  })
  @IsString()
  @IsOptional()
  @IsIn(['name', 'chargeType', 'createdAt', 'updatedAt'])
  sortBy?: string;

  @ApiPropertyOptional({
    description: 'Sort order',
    example: 'desc',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsString()
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({
    description: 'Page number',
    example: 1,
    default: 1,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of results per page',
    example: 10,
    default: 10,
    minimum: 1,
    maximum: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 10;
}
