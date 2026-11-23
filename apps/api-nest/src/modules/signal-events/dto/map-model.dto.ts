import { IsString, IsUUID, ValidateIf, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MapModelDto {
  @ApiProperty({
    description: 'The unknown model name to map (as it appears in usage events)',
    example: 'my-custom-llm',
  })
  @IsString()
  @IsNotEmpty()
  sourceModel: string;

  @ApiProperty({
    description: 'The provider of the unknown model',
    example: 'openai',
  })
  @IsString()
  @IsNotEmpty()
  sourceProvider: string;

  // --- Target: provide EITHER targetPricingId OR (targetModel + targetProvider) ---

  @ApiPropertyOptional({
    description:
      'UUID of the service_pricing row to copy costs from (use this OR targetModel+targetProvider)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ValidateIf((o) => !o.targetModel && !o.targetProvider)
  @IsUUID()
  @IsNotEmpty()
  targetPricingId?: string;

  @ApiPropertyOptional({
    description: 'Name of a known model to copy costs from (use with targetProvider)',
    example: 'gpt-4o',
  })
  @ValidateIf((o) => !o.targetPricingId)
  @IsString()
  @IsNotEmpty()
  targetModel?: string;

  @ApiPropertyOptional({
    description: 'Provider of the known model (use with targetModel)',
    example: 'openai',
  })
  @ValidateIf((o) => !o.targetPricingId)
  @IsString()
  @IsNotEmpty()
  targetProvider?: string;
}
