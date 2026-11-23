import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive, Max } from 'class-validator';
import { CUSTOMER_ALERT_METRICS, CUSTOMER_ALERT_WINDOW_MODES } from '@marginfront/db';

/**
 * WHAT THIS FILE DOES: validates edits to an existing customer watch — metric,
 * threshold, window mode, custom dates. The watched customer and the recipient
 * are fixed at create (delete and recreate to change either).
 * CONNECTS TO: customer-alerts.controller.ts (PATCH /customer-alerts/:id),
 * customer-alerts.service.ts (cross-field rules against the resulting state).
 */
export class UpdateCustomerAlertDto {
  @ApiPropertyOptional({ enum: [...CUSTOMER_ALERT_METRICS] })
  @IsOptional()
  @IsIn([...CUSTOMER_ALERT_METRICS], {
    message: "metric must be 'cost' or 'revenue'.",
  })
  metric?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 50_000_000 })
  @IsOptional()
  @IsNumber()
  @IsPositive({ message: 'thresholdUsd must be a positive dollar amount.' })
  @Max(50_000_000)
  thresholdUsd?: number;

  @ApiPropertyOptional({ enum: [...CUSTOMER_ALERT_WINDOW_MODES] })
  @IsOptional()
  @IsIn([...CUSTOMER_ALERT_WINDOW_MODES], {
    message: "windowMode must be 'month', 'rolling', or 'custom'.",
  })
  windowMode?: string;

  @ApiPropertyOptional({ description: 'Custom mode only (ISO 8601).' })
  @IsOptional()
  @IsDateString({}, { message: 'customStartDate must be an ISO 8601 date string.' })
  customStartDate?: string;

  @ApiPropertyOptional({ description: 'Custom mode only (ISO 8601).' })
  @IsOptional()
  @IsDateString({}, { message: 'customEndDate must be an ISO 8601 date string.' })
  customEndDate?: string;
}
