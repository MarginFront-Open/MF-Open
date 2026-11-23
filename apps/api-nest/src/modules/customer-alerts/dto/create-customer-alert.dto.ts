import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
  MaxLength,
} from 'class-validator';
import { CUSTOMER_ALERT_METRICS, CUSTOMER_ALERT_WINDOW_MODES } from '@marginfront/db';

/**
 * WHAT THIS FILE DOES: validates a "watch this customer" create request —
 * which customer, which money number (cost or revenue), the dollar tripwire,
 * and which window to measure it over.
 * CONNECTS TO: customer-alerts.controller.ts (POST /customer-alerts),
 * customer-alerts.service.ts (cross-field rules: custom dates iff custom mode,
 * notifyEmail rules per caller type).
 */
export class CreateCustomerAlertDto {
  @ApiProperty({ description: 'The customer to watch (internal UUID, not externalId).' })
  @IsUUID(undefined, { message: 'customerId must be the customer’s internal UUID.' })
  customerId: string;

  @ApiProperty({
    description:
      "'cost' (what this customer costs us) or 'revenue' (what they owe us), " +
      'both read through the canonical metrics layer.',
    enum: [...CUSTOMER_ALERT_METRICS],
  })
  @IsIn([...CUSTOMER_ALERT_METRICS], {
    message: "metric must be 'cost' or 'revenue'.",
  })
  metric: string;

  @ApiProperty({
    description: 'The tripwire, in US dollars. The alert fires when the metric passes this.',
    example: 500,
    minimum: 0,
    maximum: 50_000_000,
  })
  @IsNumber()
  @IsPositive({ message: 'thresholdUsd must be a positive dollar amount.' })
  @Max(50_000_000)
  thresholdUsd: number;

  @ApiProperty({
    description:
      "The window to measure: 'month' (this UTC calendar month, re-arms monthly), " +
      "'rolling' (last 30 days, fires once per crossing), or 'custom' (a fixed " +
      'range; fires at most once and expires at range end).',
    enum: [...CUSTOMER_ALERT_WINDOW_MODES],
  })
  @IsIn([...CUSTOMER_ALERT_WINDOW_MODES], {
    message: "windowMode must be 'month', 'rolling', or 'custom'.",
  })
  windowMode: string;

  @ApiPropertyOptional({
    description: 'Custom mode only: the range start (ISO 8601). Forbidden in other modes.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'customStartDate must be an ISO 8601 date string.' })
  customStartDate?: string;

  @ApiPropertyOptional({
    description: 'Custom mode only: the range end (ISO 8601). Forbidden in other modes.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'customEndDate must be an ISO 8601 date string.' })
  customEndDate?: string;

  @ApiPropertyOptional({
    description:
      'Who gets the alert emails. REQUIRED for API-key callers (an API key has no ' +
      'person behind it) and must be the email of an org member with a money role ' +
      '(owner, admin, or finance). Session callers may omit it (alerts go to you) ' +
      'or pass their own email.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'notifyEmail must be a valid email address.' })
  @MaxLength(255)
  notifyEmail?: string;
}
