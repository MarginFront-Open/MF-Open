import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { SignalsService } from './signals.service';
import { CreateSignalDto } from './dto/create-signal.dto';
import { UpdateSignalDto } from './dto/update-signal.dto';
import { QuerySignalDto } from './dto/query-signal.dto';
import { BulkSignalDto } from './dto/bulk-signal.dto';
import { ClassifySignalDto } from './dto/classify-signal.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
// MANAGE_BUILD_ROLES: signal CRUD (create/bulk/update/delete) is a meter DEFINITION write =
// BUILD/operations (owner/admin). MANAGE_MONEY_ROLES: signal CLASSIFICATION is a NUMBERS write
// (assigns the COGS/R&D accounting category) = MONEY (owner/admin/finance). Two distinct gates
// on the same controller.
import { MANAGE_MONEY_ROLES, MANAGE_BUILD_ROLES } from '@marginfront/db';

// Canonical:    /v1/signals
// Alias:        /v1/org/:orgId/signals
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('Signals')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller()
export class SignalsController {
  constructor(private readonly signalsService: SignalsService) {}

  @Post(['signals', 'org/:orgId/signals'])
  @ApiOperation({ summary: 'Create a new signal' })
  @ApiResponse({ status: 201, description: 'Signal created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() createSignalDto: CreateSignalDto) {
    const signal = await this.signalsService.create(user.organizationId, createSignalDto);
    return signal;
  }

  @Post(['signals/bulk', 'org/:orgId/signals/bulk'])
  @ApiOperation({ summary: 'Bulk create or update signals' })
  @ApiResponse({ status: 201, description: 'Signals created/updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error' })
  @ApiResponse({ status: 404, description: 'Agent or signal not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async bulkCreateOrUpdate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() bulkSignalDto: BulkSignalDto,
  ) {
    const result = await this.signalsService.bulkCreateOrUpdate(user.organizationId, bulkSignalDto);
    return result;
  }

  @Get(['signals', 'org/:orgId/signals'])
  @ApiOperation({ summary: 'Get all signals with pagination and filtering' })
  @ApiResponse({ status: 200, description: 'Returns paginated list of signals' })
  async findAll(@CurrentUser() user: AuthenticatedUser, @Query() queryDto: QuerySignalDto) {
    return this.signalsService.findAll(user.organizationId, queryDto);
  }

  @Get(['signals/:id', 'org/:orgId/signals/:id'])
  @ApiOperation({ summary: 'Get a signal by ID' })
  @ApiResponse({ status: 200, description: 'Returns the signal' })
  @ApiResponse({ status: 404, description: 'Signal not found' })
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.signalsService.findOne(id, user.organizationId);
  }

  @Patch(['signals/:id', 'org/:orgId/signals/:id'])
  @ApiOperation({ summary: 'Update a signal' })
  @ApiResponse({ status: 200, description: 'Signal updated successfully' })
  @ApiResponse({ status: 404, description: 'Signal or agent not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() updateSignalDto: UpdateSignalDto,
  ) {
    const result = await this.signalsService.update(id, user.organizationId, updateSignalDto);
    return result;
  }

  @Patch(['signals/:id/classification', 'org/:orgId/signals/:id/classification'])
  @ApiOperation({
    summary: "Set the signal's accounting cost classification (COGS / R&D / etc.)",
  })
  @ApiResponse({ status: 200, description: 'Signal classification updated' })
  @ApiResponse({ status: 404, description: 'Signal not found' })
  // Signal cost-classification IS a money write — it sets the accounting
  // cost category (COGS / R&D) that feeds margins and the books. Gate it to Manage-MONEY
  // (owner/admin/finance) in the caller's OWN org, the same lock the dashboard classifySignal
  // action carries, so this REST twin can't be used to bypass it. (Signal CRUD —
  // create/update/bulk/delete above/below — is a metering-DEFINITION write, gated by
  // MANAGE_BUILD_ROLES, not money.)
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_MONEY_ROLES)
  @OrgFromUser()
  async classify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ClassifySignalDto,
  ) {
    const signal = await this.signalsService.classify(id, user.organizationId, dto);
    return signal;
  }

  @Delete(['signals/:id', 'org/:orgId/signals/:id'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a signal' })
  @ApiResponse({ status: 204, description: 'Signal deleted successfully' })
  @ApiResponse({ status: 404, description: 'Signal not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const result = await this.signalsService.remove(id, user.organizationId);
    return result;
  }
}
