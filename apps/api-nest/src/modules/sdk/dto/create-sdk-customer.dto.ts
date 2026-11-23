import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsEnum, IsNumber, IsArray, Min } from 'class-validator';

export enum CustomerStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

export class CreateSdkCustomerDto {
  @ApiProperty({ description: 'Customer name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'External customer ID', required: false })
  @IsString()
  @IsOptional()
  externalId?: string;

  @ApiProperty({ description: 'Customer email', required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Customer phone', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Customer timezone', required: false })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty({
    description: 'Customer status',
    enum: CustomerStatus,
    required: false,
  })
  @IsEnum(CustomerStatus)
  @IsOptional()
  status?: CustomerStatus;

  @ApiProperty({ description: 'Billing contact name', required: false })
  @IsString()
  @IsOptional()
  billingContactName?: string;

  @ApiProperty({ description: 'Billing contact email', required: false })
  @IsEmail()
  @IsOptional()
  billingContactEmail?: string;

  @ApiProperty({
    description: 'Net payment terms in days',
    required: false,
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  netTerms?: number;

  @ApiProperty({
    description: 'Invoice email recipients',
    required: false,
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  invoiceEmailRecipients?: string[];

  @ApiProperty({ description: 'Customer metadata', required: false })
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiProperty({
    description: 'Agent code (external ID set in the UI) to auto-create subscription',
    required: false,
  })
  @IsString()
  @IsOptional()
  agentCode?: string;
}
