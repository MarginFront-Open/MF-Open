import { IsString, IsUUID, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export enum SignalType {
  USAGE = 'usage',
  VOLUME = 'volume',
}

export class CreateSignalDto {
  @ApiProperty({
    description: 'Signal name',
    example: 'API Calls',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  @ApiPropertyOptional({
    description: 'Short name for the signal',
    example: 'api_calls',
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  shortName?: string;

  @ApiProperty({
    description: 'Agent ID this signal belongs to',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  @IsUUID()
  agentId: string;

  @ApiPropertyOptional({
    description:
      'Signal type — "usage" means billed per result (OUTCOME), "volume" means billed per attempt (ACTIVITY)',
    enum: SignalType,
    example: SignalType.USAGE,
  })
  @IsOptional()
  @IsString()
  type?: string;
}
