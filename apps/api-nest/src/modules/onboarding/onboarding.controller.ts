import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { PrismaService } from '../../common/prisma/prisma.service';

import {
  ScreenshotDto,
  ScreenshotResponseDto,
  EnhancedPreviewDto,
  EnhancedPreviewResponseDto,
  CreateFromPreviewDto,
  CreateFromPreviewResponseDto,
  WebsiteOnboardingDto,
  QuickOnboardingDto,
  ExtractDataDto,
  ExtractDataResponseDto,
  PreviewBillingDto,
} from './dto';

@ApiTags('Onboarding')
@Controller('onboarding')
@ApiBearerAuth()
export class OnboardingController {
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Cross-tenant WRITE guard: these handlers write billing data keyed off the
   * request body's `organizationId`, so the caller must be proven a ba_member of THAT org.
   * Same-org fast-path, then a ba_member
   * lookup. Fails closed on a missing userId: Prisma drops an undefined `where` field, which
   * would collapse the query to "first member of the target org" and reopen the hole.
   */
  private async assertOrgMembership(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<void> {
    if (user.organizationId === organizationId) {
      return;
    }
    if (!user.userId) {
      throw new ForbiddenException('You do not have access to this organization');
    }
    const membership = await this.prisma.ba_member.findFirst({
      where: { organizationId, userId: user.userId },
      select: { role: true },
    });
    if (!membership) {
      throw new ForbiddenException('You do not have access to this organization');
    }
  }

  @Post('screenshot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Capture website screenshot',
    description: 'Fast endpoint to capture website screenshot only (for loading UX)',
  })
  @ApiResponse({
    status: 200,
    description: 'Screenshot captured successfully',
    type: ScreenshotResponseDto,
  })
  async getScreenshot(@Body() dto: ScreenshotDto): Promise<ScreenshotResponseDto> {
    return this.onboardingService.getScreenshot(dto);
  }

  @Post('enhanced-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate enhanced preview with AI analysis',
    description:
      'Scrapes website, pricing page, and generates complete billing setup preview with AI-powered analysis. Returns toggleable items for user review before creation. This is a long-running operation (may take 60-180 seconds).',
  })
  @ApiResponse({
    status: 200,
    description: 'Enhanced preview generated successfully',
    type: EnhancedPreviewResponseDto,
  })
  async enhancedPreview(@Body() dto: EnhancedPreviewDto): Promise<EnhancedPreviewResponseDto> {
    return this.onboardingService.enhancedPreview(dto);
  }

  @Post('create-from-preview')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OrgRoleGuard)
  @OrgRoles()
  @OrgFromUser()
  @ApiOperation({
    summary: 'Create billing setup from enhanced preview data',
    description:
      'Creates agents, signals, pricing plans, and sample customers from preview data. Updates organization information.',
  })
  @ApiResponse({
    status: 201,
    description: 'Billing setup created successfully',
    type: CreateFromPreviewResponseDto,
  })
  async createFromEnhancedPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFromPreviewDto,
  ): Promise<CreateFromPreviewResponseDto> {
    await this.assertOrgMembership(user, dto.organizationId);
    return this.onboardingService.createFromPreview(dto);
  }

  @Post('extract')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extract company data from website',
    description:
      'Extracts company information (name, description, logo) without creating any records',
  })
  @ApiResponse({
    status: 200,
    description: 'Company data extracted successfully',
    type: ExtractDataResponseDto,
  })
  async extractCompanyData(@Body() dto: ExtractDataDto): Promise<ExtractDataResponseDto> {
    return this.onboardingService.extractCompanyData(dto);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview billing setup',
    description: 'Preview billing setup without creating anything (alias for enhanced-preview)',
  })
  @ApiResponse({
    status: 200,
    description: 'Billing preview generated successfully',
  })
  async previewBillingSetup(@Body() dto: PreviewBillingDto) {
    return this.onboardingService.previewBillingSetup(dto);
  }

  @Post('website')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OrgRoleGuard)
  @OrgRoles()
  @OrgFromUser()
  @ApiOperation({
    summary: 'Onboard organization from website',
    description:
      'Onboard organization from website with full billing setup. Can optionally skip billing and only update company info.',
  })
  @ApiResponse({
    status: 201,
    description: 'Organization onboarded successfully',
  })
  async onboardFromWebsite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WebsiteOnboardingDto,
  ) {
    await this.assertOrgMembership(user, dto.organizationId);
    return this.onboardingService.onboardFromWebsite(dto);
  }

  @Post('quick')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OrgRoleGuard)
  @OrgRoles()
  @OrgFromUser()
  @ApiOperation({
    summary: 'Quick onboard with minimal information',
    description:
      'Quick onboard creates basic agent and signals for existing organization without website scraping',
  })
  @ApiResponse({
    status: 201,
    description: 'Quick onboarding completed successfully',
  })
  async quickOnboard(@CurrentUser() user: AuthenticatedUser, @Body() dto: QuickOnboardingDto) {
    await this.assertOrgMembership(user, dto.organizationId);
    return this.onboardingService.quickOnboard(dto);
  }
}
