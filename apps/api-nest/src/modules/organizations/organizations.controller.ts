import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  Request,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto';
import { getUserId, requireHumanAuth } from '../../common/helpers/get-user-id';
import { OrgRoleGuard, OrgRoles } from '../../common/guards/org-role.guard';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('current')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get current user organization' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Returns current organization',
  })
  async getCurrentOrganization(@Request() req) {
    // API key auth: skip user lookup, return org directly using organizationId
    if (req.user?.authMethod === 'api-key') {
      return this.organizationsService.getOrganizationById(req.user.organizationId);
    }

    // Human auth: look up the user's orgs through the canonical ba_member table.
    const userId = getUserId(req.user);
    const userOrgId = req.user?.organizationId;
    return this.organizationsService.getCurrentOrganization(userId, userOrgId);
  }

  @Get(':id/switch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Switch to a different organization' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Organization switched successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User is not a member of this organization',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Organization onboarding incomplete',
  })
  async switchOrganization(@Request() req, @Param('id') id: string) {
    requireHumanAuth(req.user);
    const userId = getUserId(req.user);
    return this.organizationsService.switchOrganization(userId, id);
  }

  @Get(':id')
  @UseGuards(OrgRoleGuard)
  @OrgRoles()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get organization by ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Returns organization details',
  })
  async getOrganizationById(@Param('id') id: string) {
    return this.organizationsService.getOrganizationById(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new organization' })
  @ApiBody({ type: CreateOrganizationDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Organization created successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data',
  })
  async createOrganization(@Request() req, @Body() createDto: CreateOrganizationDto) {
    requireHumanAuth(req.user);
    const userId = getUserId(req.user);
    return this.organizationsService.createOrganization(userId, createDto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update an organization' })
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Organization updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'User is not an owner of this organization',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Organization not found',
  })
  async updateOrganization(
    @Request() req,
    @Param('id') id: string,
    @Body() updateDto: UpdateOrganizationDto,
  ) {
    requireHumanAuth(req.user);
    const userId = getUserId(req.user);
    return this.organizationsService.updateOrganization(userId, id, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an organization' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Organization deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'User is not an owner of this organization',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cannot delete organization with active subscriptions',
  })
  async deleteOrganization(@Request() req, @Param('id') id: string) {
    requireHumanAuth(req.user);
    const userId = getUserId(req.user);
    return this.organizationsService.deleteOrganization(userId, id);
  }
}
