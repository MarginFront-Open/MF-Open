import { IsOptional, IsUUID, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class EventAnalyticsQueryDto {
  @ApiPropertyOptional({
    description: 'Start date for analytics (ISO 8601, defaults to 30 days ago)',
    example: '2025-01-01T00:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date for analytics (ISO 8601, defaults to now)',
    example: '2025-12-31T23:59:59Z',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;

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
}
