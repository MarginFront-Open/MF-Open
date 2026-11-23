import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { StripeConnectService } from './stripe-connect.service';
import { GenerateOAuthUrlDto, ConnectAccountDto } from './dto';
// Connecting or disconnecting a Stripe payout account redirects where revenue
// lands, so it is gated to ORG_MANAGE_ROLES (owner/admin), not MANAGE_BUILD:
// the 'developer' role holds MANAGE_BUILD and must not change payout destinations.
import {
  OrgRoleGuard,
  OrgRoles,
  ORG_MANAGE_ROLES,
  HumanOnly,
} from '../../common/guards/org-role.guard';
import { PRIV_READ_PAYOUT } from '@marginfront/db';

@ApiTags('stripe-connect')
@Controller('org/:orgId/stripe-connect')
@ApiBearerAuth()
export class StripeConnectController {
  constructor(private readonly stripeConnectService: StripeConnectService) {}

  @Post('oauth-url')
  @UseGuards(OrgRoleGuard)
  @HumanOnly() // redirecting where revenue lands is human-only, never an API key
  @OrgRoles(...ORG_MANAGE_ROLES)
  @ApiOperation({ summary: 'Generate OAuth URL for connecting existing Stripe account' })
  @ApiResponse({ status: 200, description: 'OAuth URL generated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async generateOAuthUrl(@Param('orgId') orgId: string, @Body() dto: GenerateOAuthUrlDto) {
    const result = await this.stripeConnectService.generateOAuthUrl(orgId, dto);
    return result;
  }

  @Post('connect')
  @UseGuards(OrgRoleGuard)
  @HumanOnly() // redirecting where revenue lands is human-only, never an API key
  @OrgRoles(...ORG_MANAGE_ROLES)
  @ApiOperation({ summary: 'Complete OAuth flow and connect existing Stripe account' })
  @ApiResponse({ status: 200, description: 'Account connected successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async connectExistingAccount(@Param('orgId') orgId: string, @Body() dto: ConnectAccountDto) {
    // SECURITY: the OrgRoleGuard above authorized this caller as an owner/admin of
    // the org named in the URL (:orgId). But the service derives the org it actually mutates
    // from `dto.state` — an UNSIGNED, client-supplied base64 blob. Without tying the two
    // together, a caller who is owner/admin of their OWN org could pass the guard at
    // /org/<their-org>/stripe-connect/connect while handing in a hand-crafted state naming a
    // VICTIM org, hijacking that org's payouts. So we decode the state HERE and demand it
    // names the same org the guard checked. If it doesn't match (or can't be parsed), refuse.
    let stateOrganizationId: string | undefined;
    try {
      const decoded = JSON.parse(Buffer.from(decodeURIComponent(dto.state), 'base64').toString());
      stateOrganizationId = decoded?.organizationId;
    } catch {
      // A state we can't even decode is not a state we'll trust.
      throw new BadRequestException('Invalid Stripe Connect state parameter');
    }
    if (!stateOrganizationId || stateOrganizationId !== orgId) {
      throw new ForbiddenException(
        'Stripe Connect state does not match the requested organization',
      );
    }

    const result = await this.stripeConnectService.connectExistingAccount(dto);
    return result;
  }

  @Post('disconnect')
  @UseGuards(OrgRoleGuard)
  @HumanOnly() // redirecting where revenue lands is human-only, never an API key
  @OrgRoles(...ORG_MANAGE_ROLES)
  @ApiOperation({ summary: 'Disconnect Stripe account' })
  @ApiResponse({ status: 200, description: 'Account disconnected successfully' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async disconnectAccount(@Param('orgId') orgId: string) {
    const result = await this.stripeConnectService.disconnectAccount(orgId);
    return result;
  }

  @Get('status')
  @UseGuards(OrgRoleGuard)
  // Where revenue lands is money-sensitive: developer is excluded even
  // though it holds MANAGE_BUILD elsewhere, and so is member.
  @OrgRoles(...PRIV_READ_PAYOUT)
  @ApiOperation({ summary: 'Get Stripe Connect account status' })
  @ApiResponse({ status: 200, description: 'Account status retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getAccountStatus(@Param('orgId') orgId: string) {
    return this.stripeConnectService.getAccountStatus(orgId);
  }
}
