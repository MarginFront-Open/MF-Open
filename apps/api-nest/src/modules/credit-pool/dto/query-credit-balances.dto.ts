import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class QueryCreditBalancesDto {
  @ApiPropertyOptional({
    description: 'Only pools belonging to this customer.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description: 'Only pools on subscriptions for this agent.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional({
    description:
      'Only pools with this percent of the pool (or less) still left. 20 is the ' +
      'near-empty cut the dashboard uses; 0 narrows it to pools at or past zero. ' +
      'Negative values are allowed because an overdrawn pool is past zero.',
    minimum: -100,
    maximum: 100,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-100)
  @Max(100)
  belowPercent?: number;
}
