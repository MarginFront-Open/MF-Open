import { IsString, IsUrl, IsNotEmpty, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class EnhancedPreviewDto {
  @ApiProperty({
    description: 'Website URL to analyze',
    example: 'https://example.com',
  })
  @IsString()
  @IsUrl()
  @IsNotEmpty()
  websiteUrl: string;

  @ApiProperty({
    description: 'Number of sample customers to generate',
    example: 4,
    required: false,
    default: 4,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(10)
  customerCount?: number = 4;
}

export class CompanyInfoDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  description: string;

  @ApiProperty()
  industry?: string;

  @ApiProperty()
  website: string;

  @ApiProperty()
  logo?: string;

  @ApiProperty()
  screenshotUrl?: string;
}

export class PricingTierDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  basePrice: number;

  @ApiProperty({ enum: ['monthly', 'yearly'] })
  billingCycle: 'monthly' | 'yearly';

  @ApiProperty()
  features: string[];

  @ApiProperty({ required: false })
  isEnterprise?: boolean;

  @ApiProperty({ required: false })
  description?: string;
}

export class SampleCustomerDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ required: false })
  company?: string;

  @ApiProperty({ required: false })
  industry?: string;

  @ApiProperty({ required: false })
  phoneNumber?: string;
}

export class AgentPreviewDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  agentCode: string;

  @ApiProperty()
  description: string;
}

export class SignalPreviewDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  shortName: string;

  @ApiProperty({ enum: ['usage', 'volume'] })
  type: 'usage' | 'volume';

  @ApiProperty()
  agentCode: string;
}

export class PricingDataDto {
  @ApiProperty({ type: [PricingTierDto] })
  tiers: PricingTierDto[];

  @ApiProperty({ type: [SignalPreviewDto] })
  signals: SignalPreviewDto[];

  @ApiProperty({ type: [], required: false })
  serviceCosts?: any[];
}

export class SummaryDto {
  @ApiProperty()
  pricingTiersCount: number;

  @ApiProperty()
  signalsCount: number;

  @ApiProperty()
  serviceCostsCount: number;

  @ApiProperty()
  customersCount: number;
}

export class EnhancedPreviewResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  websiteUrl: string;

  @ApiProperty({ required: false })
  pricingPageUrl?: string | null;

  @ApiProperty({ type: CompanyInfoDto })
  companyInfo: CompanyInfoDto;

  @ApiProperty({ type: PricingDataDto })
  pricingData: PricingDataDto;

  @ApiProperty({ type: [SampleCustomerDto] })
  customers: SampleCustomerDto[];

  @ApiProperty({ type: [AgentPreviewDto] })
  agents: AgentPreviewDto[];

  @ApiProperty({ type: SummaryDto })
  summary: SummaryDto;

  @ApiProperty({ required: false })
  message?: string;
}
