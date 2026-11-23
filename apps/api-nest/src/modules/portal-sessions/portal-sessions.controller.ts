import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity, ApiQuery } from '@nestjs/swagger';
import { SecretKeyGuard } from '../../common/guards/secret-key.guard';
import { PortalSessionsService } from './portal-sessions.service';
import { CreatePortalSessionDto } from './dto/create-portal-session.dto';

/**
 * Portal Sessions API
 *
 * Create and manage portal sessions for your customers.
 * Portal sessions provide a secure, short-lived URL that allows customers
 * to access their billing information without exposing your API key.
 *
 * This follows the Stripe/Chargebee pattern:
 * 1. Your backend creates a portal session using your secret key
 * 2. You redirect the customer to the portal URL
 * 3. Customer can view invoices, subscriptions, usage (1 hour expiry)
 *
 * @example
 * // Server-side (Node.js)
 * const session = await marginfront.portalSessions.create({
 *   customerId: 'cust_123',
 *   returnUrl: 'https://myapp.com/account'
 * });
 *
 * // Redirect customer
 * res.redirect(session.url);
 */
// Canonical: /v1/portal-sessions
// Alias:     /v1/sdk/portal-sessions
@ApiTags('portal-sessions')
@Controller(['portal-sessions', 'sdk/portal-sessions'])
@UseGuards(SecretKeyGuard)
@ApiSecurity('api-key')
export class PortalSessionsController {
  constructor(private readonly portalSessionsService: PortalSessionsService) {}

  /**
   * Create a new portal session
   *
   * Creates a short-lived portal session for a customer.
   * The returned URL can be used to redirect the customer to their billing portal.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a portal session',
    description: `
Creates a short-lived portal session for a customer. The session expires after 1 hour.

**Usage:**
1. Call this endpoint from your server with your secret key
2. Redirect the customer to the returned URL
3. Customer can view/manage their billing for 1 hour

**Required:** Secret key (mf_sk_*). Publishable keys cannot create portal sessions.
    `,
  })
  @ApiResponse({
    status: 201,
    description: 'Portal session created successfully',
    schema: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        object: 'portal_session',
        url: 'https://yourapp.com/portal?token=prtl_xxxx',
        token: 'prtl_xxxx',
        customerId: 'cust_123',
        customerName: 'Acme Corp',
        customerEmail: 'billing@acme.example',
        expiresAt: '2024-01-01T01:00:00.000Z',
        features: ['invoices', 'subscriptions', 'usage', 'profile'],
        returnUrl: 'https://myapp.com/account',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - missing customer identifier',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - secret key required',
  })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async createPortalSession(@Request() req: any, @Body() dto: CreatePortalSessionDto) {
    const result = await this.portalSessionsService.createPortalSession(
      req.user.organizationId,
      dto,
      // Lets the service re-check the minting key inside the link
      // insert's transaction, closing the mint-races-revoke window.
      req.user.apiKeyId,
    );
    return result;
  }

  /**
   * List portal sessions
   * NOTE: This must be declared BEFORE the :sessionId route to avoid conflicts
   */
  @Get()
  @ApiOperation({
    summary: 'List portal sessions',
    description: 'List all portal sessions, optionally filtered by customer.',
  })
  @ApiQuery({
    name: 'customerId',
    required: false,
    description: 'Filter by customer ID',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum number of sessions to return',
    type: Number,
  })
  @ApiQuery({
    name: 'includeExpired',
    required: false,
    description: 'Include expired sessions',
    type: Boolean,
  })
  @ApiResponse({
    status: 200,
    description: 'Portal sessions retrieved successfully',
  })
  async listPortalSessions(
    @Request() req: any,
    @Query('customerId') customerId?: string,
    @Query('limit') limit?: number,
    @Query('includeExpired') includeExpired?: boolean,
  ) {
    return this.portalSessionsService.listPortalSessions(req.user.organizationId, customerId, {
      limit,
      includeExpired,
    });
  }

  /**
   * Get a portal session by ID
   */
  @Get(':sessionId')
  @ApiOperation({
    summary: 'Get a portal session',
    description: 'Retrieve details of a portal session by its ID.',
  })
  @ApiResponse({
    status: 200,
    description: 'Portal session retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Portal session not found' })
  async getPortalSession(@Request() req: any, @Param('sessionId') sessionId: string) {
    const session = await this.portalSessionsService.getPortalSession(
      req.user.organizationId,
      sessionId,
    );

    if (!session) {
      throw new NotFoundException(`Portal session not found: ${sessionId}`);
    }

    return session;
  }

  /**
   * Revoke (delete) a portal session
   */
  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke a portal session',
    description: 'Immediately revoke a portal session, preventing further access.',
  })
  @ApiResponse({
    status: 204,
    description: 'Portal session revoked successfully',
  })
  @ApiResponse({ status: 404, description: 'Portal session not found' })
  async revokePortalSession(@Request() req: any, @Param('sessionId') sessionId: string) {
    await this.portalSessionsService.revokePortalSession(req.user.organizationId, sessionId);
  }
}
