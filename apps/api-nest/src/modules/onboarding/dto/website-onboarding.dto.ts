import { IsString, IsUrl, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class WebsiteOnboardingDto {
  @ApiProperty({
    description: 'Organization ID to onboard',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @ApiProperty({
    description: 'Website URL to analyze',
    example: 'https://example.com',
  })
  @IsString()
  @IsUrl()
  @IsNotEmpty()
  websiteUrl: string;

  @ApiProperty({
    description: 'Skip billing setup (only extract company info)',
    example: false,
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  skipBilling?: boolean = false;
}
