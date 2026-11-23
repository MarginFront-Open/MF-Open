import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, Min, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export class QuerySdkSubscriptionsDto {
  @ApiPropertyOptional({ description: 'Filter by customer ID' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Filter by customer external ID' })
  @IsOptional()
  @IsString()
  customerExternalId?: string;

  @ApiPropertyOptional({ description: 'Filter by agent ID' })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Filter by status',
    enum: ['upcoming', 'active', 'ended', 'canceled', 'expired', 'pending'],
  })
  @IsOptional()
  @IsEnum(['upcoming', 'active', 'ended', 'canceled', 'expired', 'pending'])
  status?: string;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
