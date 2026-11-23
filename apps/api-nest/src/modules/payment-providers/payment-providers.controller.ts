import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { PaymentProvidersService } from './payment-providers.service';
import { CreatePaymentProviderDto, UpdatePaymentProviderDto } from './dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OrgRoleGuard,
  OrgRoles,
  ORG_MANAGE_ROLES,
  HumanOnly,
} from '../../common/guards/org-role.guard';
import { PRIV_READ_PAYOUT } from '@marginfront/db';

@ApiTags('Payment Providers')
@ApiBearerAuth()
@Controller('org/:orgId/payment-providers')
export class PaymentProvidersController {
  constructor(
    private readonly paymentProvidersService: PaymentProvidersService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Validates that the user has access to the specified organization.
   * Checks both primary organization and CANONICAL ba_member membership.
   */
  private async validateOrganizationAccess(user: AuthenticatedUser, orgId: string): Promise<void> {
    // Primary-org / same-org api-key fast path.
    if (user.organizationId === orgId) {
      return;
    }

    // Fail closed when the human can't be identified: never run the lookup with
    // userId: undefined. Prisma drops undefined `where` fields, which would degenerate to
    // `WHERE organizationId = orgId` and match the first member of the TARGET org.
    if (!user.userId) {
      throw new ForbiddenException('You do not have access to this organization');
    }

    const membership = await this.prisma.ba_member.findFirst({
      where: { organizationId: orgId, userId: user.userId },
      select: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You do not have access to this organization');
    }
  }

  @Post()
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiOperation({ summary: 'Connect a new payment provider' })
  @ApiResponse({
    status: 201,
    description: 'Provider connected successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request - validation error' })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  // Connecting or disconnecting a payout provider redirects where revenue lands, so it is
  // owner/admin only (ORG_MANAGE). That excludes the 'developer' role, which holds
  // MANAGE_BUILD but must not change payout destinations. Matches stripe-connect. The guard
  // enforces ba_member membership AND role from the URL org; the in-handler
  // validateOrganizationAccess stays as a second membership check.
  @UseGuards(OrgRoleGuard)
  @HumanOnly() // connecting a payout provider is human-only, never an API key
  @OrgRoles(...ORG_MANAGE_ROLES)
  async create(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() createDto: CreatePaymentProviderDto,
  ) {
    await this.validateOrganizationAccess(user, orgId);
    const result = await this.paymentProvidersService.create(orgId, createDto);
    return result;
  }

  @Get()
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiOperation({ summary: 'Get all payment providers' })
  @ApiResponse({
    status: 200,
    description: 'Returns list of payment providers',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  // Payment-provider status and routing (which processor gets the revenue) is in the same
  // money-sensitive class as stripe-connect status, PRIV_READ_PAYOUT: finance keeps it,
  // developer does not. The encrypted secret value is never returned here
  // (payment-providers.service.ts always strips encrypted_secrets).
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...PRIV_READ_PAYOUT)
  async findAll(@Param('orgId') orgId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.validateOrganizationAccess(user, orgId);
    return this.paymentProvidersService.findAll(orgId);
  }

  @Get(':providerId')
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiParam({ name: 'providerId', description: 'Payment Provider ID' })
  @ApiOperation({ summary: 'Get a payment provider by ID' })
  @ApiResponse({
    status: 200,
    description: 'Returns payment provider details',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  // Same role gate as GET / above.
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...PRIV_READ_PAYOUT)
  async findOne(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('providerId') providerId: string,
  ) {
    await this.validateOrganizationAccess(user, orgId);
    return this.paymentProvidersService.findOne(orgId, providerId);
  }

  @Patch(':providerId')
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiParam({ name: 'providerId', description: 'Payment Provider ID' })
  @ApiOperation({ summary: 'Update a payment provider' })
  @ApiResponse({ status: 200, description: 'Provider updated successfully' })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @UseGuards(OrgRoleGuard)
  @HumanOnly() // reconfiguring a payout provider is human-only, never an API key
  @OrgRoles(...ORG_MANAGE_ROLES)
  async update(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('providerId') providerId: string,
    @Body() updateDto: UpdatePaymentProviderDto,
  ) {
    await this.validateOrganizationAccess(user, orgId);
    const result = await this.paymentProvidersService.update(orgId, providerId, updateDto);
    return result;
  }

  @Delete(':providerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiParam({ name: 'providerId', description: 'Payment Provider ID' })
  @ApiOperation({ summary: 'Disconnect a payment provider' })
  @ApiResponse({
    status: 204,
    description: 'Provider disconnected successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization',
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @UseGuards(OrgRoleGuard)
  @HumanOnly() // disconnecting a payout provider is human-only, never an API key
  @OrgRoles(...ORG_MANAGE_ROLES)
  async remove(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('providerId') providerId: string,
  ) {
    await this.validateOrganizationAccess(user, orgId);
    const result = await this.paymentProvidersService.remove(orgId, providerId);
    return result;
  }
}
