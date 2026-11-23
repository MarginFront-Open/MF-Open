import {
  IsString,
  IsOptional,
  IsUrl,
  IsIn,
  MinLength,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateOrganizationDto {
  @ApiProperty({ description: 'Organization name', minLength: 2, maxLength: 255 })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ description: 'Organization description/info' })
  @IsString()
  @IsOptional()
  organizationInfo?: string;

  @ApiPropertyOptional({ description: 'Organization website URL' })
  @ValidateIf((o) => o.website && o.website !== '')
  @IsUrl()
  @IsOptional()
  website?: string;

  @ApiPropertyOptional({ description: 'Organization LinkedIn URL' })
  @ValidateIf((o) => o.linkedin && o.linkedin !== '')
  @IsUrl()
  @IsOptional()
  linkedin?: string;

  @ApiPropertyOptional({ description: 'Organization logo URL' })
  @ValidateIf((o) => o.logo && o.logo !== '')
  @IsUrl(
    { protocols: ['https'], require_protocol: true, require_valid_protocol: true },
    {
      message:
        'Logo URL was rejected because it must be a public https:// address. Provide an https:// URL hosted on a public domain or omit the logo field.',
    },
  )
  @IsOptional()
  logo?: string;

  @ApiPropertyOptional({ description: 'Organization timezone', default: 'UTC' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ description: 'Tagline' })
  @IsString()
  @IsOptional()
  tagline?: string;

  @ApiPropertyOptional({ description: 'Address line 1' })
  @IsString()
  @IsOptional()
  address_line1?: string;

  @ApiPropertyOptional({ description: 'Address line 2' })
  @IsString()
  @IsOptional()
  address_line2?: string;

  @ApiPropertyOptional({ description: 'City' })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({ description: 'State' })
  @IsString()
  @IsOptional()
  state?: string;

  @ApiPropertyOptional({ description: 'Zip code' })
  @IsString()
  @IsOptional()
  zip_code?: string;

  @ApiPropertyOptional({ description: 'Country' })
  @IsString()
  @IsOptional()
  country?: string;

  @ApiPropertyOptional({ description: 'Billing email' })
  @IsString()
  @IsOptional()
  billing_email?: string;

  @ApiPropertyOptional({ description: 'Billing phone' })
  @IsString()
  @IsOptional()
  billing_phone?: string;

  @ApiPropertyOptional({ description: 'Default currency', default: 'USD' })
  @IsString()
  @IsOptional()
  default_currency?: string;

  @ApiPropertyOptional({
    description: 'Dashboard mode — controls which features are visible in the sidebar',
    enum: ['cost_tracking', 'revenue', 'full'],
  })
  @IsIn(['cost_tracking', 'revenue', 'full'])
  @IsOptional()
  dashboard_mode?: 'cost_tracking' | 'revenue' | 'full';
}
