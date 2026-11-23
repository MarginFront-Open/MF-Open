import { IsOptional, IsString, IsUUID, IsDateString, IsInt, Min, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class QuerySignalEventDto {
  @ApiPropertyOptional({
    description: 'Filter by customer external ID',
    example: 'cust_123',
  })
  @IsString()
  @IsOptional()
  customerExternalId?: string;

  @ApiPropertyOptional({
    description: 'Filter by agent ID',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  @IsUUID()
  @IsOptional()
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Filter by signal ID',
    example: '123e4567-e89b-12d3-a456-426614174005',
  })
  @IsUUID()
  @IsOptional()
  signalId?: string;

  @ApiPropertyOptional({
    description: 'Start date for filtering (ISO 8601)',
    example: '2025-01-01T00:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date for filtering (ISO 8601)',
    example: '2025-12-31T23:59:59Z',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Page number for pagination',
    example: 1,
    minimum: 1,
    default: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of results per page',
    example: 10,
    minimum: 1,
    maximum: 100,
    default: 10,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    example: 'usageDate',
    default: 'usageDate',
  })
  @IsString()
  @IsOptional()
  sortBy?: string = 'usageDate';

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    example: 'desc',
    default: 'desc',
  })
  @IsIn(['asc', 'desc'])
  @IsOptional()
  sortOrder?: 'asc' | 'desc' = 'desc';
}
