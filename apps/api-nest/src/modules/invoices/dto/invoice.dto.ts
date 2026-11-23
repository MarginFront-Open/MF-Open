import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  IsNumber,
  IsEnum,
  IsOptional,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * One line item on an invoice. The MarginFront dashboard, REST API, SDK, and MCP all build
 * invoices from arrays of these. Totals are derived from what each line charges, then
 * summed — callers don't compute subtotal, the service does.
 */
export class InvoiceLineItemInput {
  @ApiProperty({ description: 'Human-readable label shown on the invoice line' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ description: 'Units of the thing being billed (events, seats, hours, etc.)' })
  @IsNumber()
  @Type(() => Number)
  quantity: number;

  @ApiProperty({ description: 'Dollar price per unit (e.g. 0.50 for fifty cents)' })
  @IsNumber()
  @Type(() => Number)
  unitPrice: number;

  @ApiPropertyOptional({
    description:
      'What this line charges, in dollars. Send it when you already know the figure — a ' +
      'blended price (credit pool, tiered usage, proration) cannot be rebuilt from ' +
      'quantity x unitPrice once both are stored at two decimals. Leave it out for a ' +
      'plain "3 hours at $150" line and the product is used.',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  amount?: number;

  @ApiPropertyOptional({
    enum: ['recurring', 'usage', 'onetime', 'tax', 'discount', 'seat_based'],
    description: "Line item kind — defaults to 'recurring' if omitted",
  })
  @IsOptional()
  @IsEnum(['recurring', 'usage', 'onetime', 'tax', 'discount', 'seat_based'])
  type?: 'recurring' | 'usage' | 'onetime' | 'tax' | 'discount' | 'seat_based';

  @ApiPropertyOptional({ description: 'Free-form JSON the caller can attach for their own use' })
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class CreateInvoiceDto {
  @ApiProperty()
  @IsUUID()
  customerId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  subscriptionId?: string;

  @ApiPropertyOptional({ description: 'Invoice date (ISO string or Date)' })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  invoiceDate?: Date;

  @ApiProperty({ description: 'Due date (ISO string or Date)' })
  @IsNotEmpty()
  @Transform(({ value }) => {
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  dueDate: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  billingPeriodStart?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  billingPeriodEnd?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  taxAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  discountAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  memo?: string;

  @ApiPropertyOptional({ enum: ['draft', 'issued'] })
  @IsOptional()
  @IsEnum(['draft', 'issued'])
  status?: string;

  @ApiPropertyOptional({
    type: [InvoiceLineItemInput],
    description:
      'Line items to bill on this invoice. Totals are computed from quantity * unitPrice.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemInput)
  lineItems?: InvoiceLineItemInput[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  invoiceDate?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  dueDate?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  billingPeriodStart?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  billingPeriodEnd?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  taxAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  discountAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  memo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ type: [InvoiceLineItemInput] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemInput)
  items?: InvoiceLineItemInput[];

  @ApiPropertyOptional({ type: [InvoiceLineItemInput] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemInput)
  lineItems?: InvoiceLineItemInput[];
}

export class RecordPaymentDto {
  @ApiProperty()
  @IsNumber()
  @Type(() => Number)
  amount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  transactionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateRefundDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

export class SendInvoiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  recipientEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  message?: string;
}

/**
 * Body for POST /v1/invoices/generate. Takes a customer + subscription and (optionally)
 * a billing period to bill for. When billing period is omitted, the subscription's
 * currentBillingPeriodStart/End are used — which is the right default 99% of the time.
 */
export class GenerateInvoiceDto {
  @ApiProperty({
    description: 'The customer being billed (their MarginFront UUID, not external ID)',
  })
  @IsUUID()
  customerId: string;

  @ApiProperty({ description: 'The subscription whose usage we are turning into an invoice' })
  @IsUUID()
  subscriptionId: string;

  @ApiPropertyOptional({
    description:
      'Start of the billing period to bill for. Defaults to subscription.currentBillingPeriodStart.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  billingPeriodStart?: Date;

  @ApiPropertyOptional({
    description:
      'End of the billing period to bill for. Defaults to subscription.currentBillingPeriodEnd.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return value;
  })
  billingPeriodEnd?: Date;
}

export class QueryInvoicesDto {
  @ApiPropertyOptional({ enum: ['draft', 'sent', 'paid', 'overdue', 'void', 'issued', 'pending'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  subscriptionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  includeDetails?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsString()
  sortOrder?: string;
}
