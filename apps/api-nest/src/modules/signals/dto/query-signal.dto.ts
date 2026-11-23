import { IsOptional, IsString, IsUUID, IsEnum, IsInt, Min, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { SignalType } from './create-signal.dto';

export class QuerySignalDto {
  @ApiPropertyOptional({
    description: 'Filter by signal name (case-insensitive partial match)',
    example: 'API',
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Filter by agent ID',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  @IsUUID()
  @IsOptional()
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Filter by signal type',
    enum: SignalType,
    example: SignalType.USAGE,
  })
  @IsEnum(SignalType)
  @IsOptional()
  type?: SignalType;

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
    example: 'createdAt',
    default: 'createdAt',
  })
  @IsString()
  @IsOptional()
  sortBy?: string = 'createdAt';

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
