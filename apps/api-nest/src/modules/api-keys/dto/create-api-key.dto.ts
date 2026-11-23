import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray } from 'class-validator';

export class CreateApiKeyDto {
  @ApiProperty({ description: 'Name of the API key' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'Description of the API key' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      'Dashboard role this key should carry (ingest | member | developer | finance | legal | admin | owner). ' +
      'Defaults to the ingest floor when omitted. The mint service caps this to the roles the minter ' +
      'is allowed to hand out — an out-of-ceiling choice is rejected with a 403.',
  })
  @IsOptional()
  @IsString()
  role?: string;

  // Accepted and ignored: the `permissions` column stores the key's role
  // provenance object, so string scopes sent here are not persisted. The field
  // stays on the DTO so callers that send it don't break.
  @ApiPropertyOptional({
    description: 'Deprecated: no longer persisted. Use `role` instead.',
    type: [String],
    deprecated: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}
