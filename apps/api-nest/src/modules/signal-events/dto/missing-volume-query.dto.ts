import { IsOptional, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class MissingVolumeQueryDto {
  @ApiPropertyOptional({
    description: 'Start date filter (ISO 8601, defaults to 30 days ago)',
    example: '2026-01-01T00:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date filter (ISO 8601, defaults to now)',
    example: '2026-12-31T23:59:59Z',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;
}
