import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsUrl, IsArray, IsIn } from 'class-validator';

/**
 * Features that can be enabled in the portal.
 *
 * The portal is a single page that renders all four sections together, so
 * this list is informational: it is accepted, validated and echoed back, but
 * does not toggle UI sections.
 */
export type PortalFeature = 'invoices' | 'subscriptions' | 'usage' | 'profile';

export const PORTAL_FEATURES: PortalFeature[] = ['invoices', 'subscriptions', 'usage', 'profile'];

/**
 * DTO for creating a portal session.
 *
 * Either customerId or customerExternalId must be provided.
 */
export class CreatePortalSessionDto {
  @ApiPropertyOptional({
    description: 'Internal customer ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({
    description: "Customer's external ID (your system's customer identifier)",
    example: 'cust_abc123',
  })
  @IsOptional()
  @IsString()
  customerExternalId?: string;

  @ApiPropertyOptional({
    description:
      'URL to redirect the customer to after they leave the portal (informational; the portal does not redirect back on its own)',
    example: 'https://myapp.com/account',
  })
  @IsOptional()
  @IsUrl()
  returnUrl?: string;

  @ApiPropertyOptional({
    description:
      'Features to expose in the portal. The portal is a single page that includes all four sections; this field is validated and echoed but does not toggle visibility.',
    type: [String],
    enum: PORTAL_FEATURES,
    default: PORTAL_FEATURES,
  })
  @IsOptional()
  @IsArray()
  @IsIn(PORTAL_FEATURES, { each: true })
  features?: PortalFeature[];
}
