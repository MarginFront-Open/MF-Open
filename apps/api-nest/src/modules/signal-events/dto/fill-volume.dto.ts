import { IsString, IsInt, IsNumber, Min, IsOptional, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FillVolumeDto {
  @ApiProperty({
    description: 'The model name whose events are missing volume data',
    example: 'gpt-4o',
  })
  @IsString()
  @IsNotEmpty()
  sourceModel: string;

  @ApiProperty({
    description: 'The provider of the model',
    example: 'openai',
  })
  @IsString()
  @IsNotEmpty()
  sourceProvider: string;

  // Volume fields — the service validates which are required based on
  // the model's costUnit (LLM = tokens, non-LLM = quantity).

  @ApiPropertyOptional({
    description: 'Input tokens to apply to all matching events (required for LLM models)',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  inputTokens?: number;

  @ApiPropertyOptional({
    description: 'Output tokens to apply to all matching events (required for LLM models)',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  outputTokens?: number;

  @ApiPropertyOptional({
    description: 'Quantity to apply to all matching events (required for non-LLM services)',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  quantity?: number;
}
