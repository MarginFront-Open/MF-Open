import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsEnum,
  IsNumber,
  IsArray,
  IsObject,
} from 'class-validator';

export class UpdateCustomerDto {
  @ApiPropertyOptional({ description: 'Customer name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'External ID for the customer' })
  @IsOptional()
  @IsString()
  externalId?: string;

  @ApiPropertyOptional({ description: 'Customer email' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Customer phone number' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ description: 'Address line 1' })
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @ApiPropertyOptional({ description: 'Address line 2' })
  @IsOptional()
  @IsString()
  addressLine2?: string;

  @ApiPropertyOptional({ description: 'City' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ description: 'State' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ description: 'Zip code' })
  @IsOptional()
  @IsString()
  zipCode?: string;

  @ApiPropertyOptional({ description: 'Country' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ description: 'Customer timezone' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Customer status',
    enum: ['active', 'inactive', 'suspended'],
  })
  @IsOptional()
  @IsEnum(['active', 'inactive', 'suspended'])
  status?: string;

  @ApiPropertyOptional({ description: 'Billing contact name' })
  @IsOptional()
  @IsString()
  billingContactName?: string;

  @ApiPropertyOptional({ description: 'Billing contact email' })
  @IsOptional()
  @IsEmail()
  billingContactEmail?: string;

  @ApiPropertyOptional({ description: 'Net payment terms in days' })
  @IsOptional()
  @IsNumber()
  netTerms?: number;

  @ApiPropertyOptional({ description: 'Invoice email recipients', type: [String] })
  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true })
  invoiceEmailRecipients?: string[];

  @ApiPropertyOptional({ description: 'Additional metadata', type: 'object' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
