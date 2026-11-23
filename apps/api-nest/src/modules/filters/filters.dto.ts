import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, IsArray, IsString, IsInt, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class GetFiltersDto {
  @ApiPropertyOptional({ description: 'Filter by agent ID' })
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional({ description: 'Filter by customer ID' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description: 'Types of data to return',
    example: ['agents', 'customers', 'pricingPlans', 'signals', 'subscriptions'],
    type: [String],
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? [value] : value))
  @IsArray()
  @IsString({ each: true })
  dataTypes?: string[];

  @ApiPropertyOptional({ description: 'Sort by field:order (e.g., name:asc)' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Maximum number of results per type' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
