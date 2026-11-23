import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsBoolean, IsNumber, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class QueryServicePricingDto {
  @ApiPropertyOptional({
    description: 'Filter by provider (case-insensitive). Examples: openai, anthropic, google, tool',
  })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({
    description: 'Filter by serviceType. Examples: LLM, Embeddings, Web Search, Agent Built-in',
  })
  @IsOptional()
  @IsString()
  serviceType?: string;

  @ApiPropertyOptional({
    description: 'Filter to non-LLM API entries only (true) or LLM-only (false). Omit to get both.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  isApi?: boolean;

  @ApiPropertyOptional({
    description: 'Search across canonicalName and displayName (case-insensitive ilike)',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Items per page',
    minimum: 1,
    maximum: 100,
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;
}
