import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { SignalEventsService } from './signal-events.service';
// These three writes are OPERATIONAL
// metering edits: deleting cost events, remapping which MODEL an event used, or filling an
// event's volume. They touch the dev/operations plumbing (which model, a meter's makeup) — NOT
// the accounting numbers — so they belong to the developers (owner/admin), not finance, under
// Manage-BUILD. (Signal cost
// CLASSIFICATION — assigning a COGS/R&D category — stays Manage-MONEY in signals.controller.ts.)
// @OrgFromUser because the service scopes every write to user.organizationId (the :orgId alias
// is ignored). The GET reads and the separate ingestion path stay open. Same-org API keys still
// pass (within-org SDK traffic); plain human members are blocked.
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { MANAGE_BUILD_ROLES } from '@marginfront/db';
import { QuerySignalEventDto } from './dto/query-signal-event.dto';
import { DeleteSignalEventsDto } from './dto/delete-signal-events.dto';
import { EventAnalyticsQueryDto } from './dto/event-analytics-query.dto';
import { NeedsCostBackfillQueryDto } from './dto/needs-cost-backfill-query.dto';
import { MapModelDto } from './dto/map-model.dto';
import { MissingVolumeQueryDto } from './dto/missing-volume-query.dto';
import { FillVolumeDto } from './dto/fill-volume.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';

// Canonical:    /v1/events
// Alias:        /v1/org/:orgId/events
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('Events')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller()
export class SignalEventsController {
  constructor(private readonly signalEventsService: SignalEventsService) {}

  @Get(['events', 'org/:orgId/events'])
  @ApiOperation({ summary: 'Get all signal events with pagination and filtering' })
  @ApiResponse({
    status: 200,
    description: 'Returns paginated list of signal events',
  })
  async findAll(@CurrentUser() user: AuthenticatedUser, @Query() queryDto: QuerySignalEventDto) {
    return this.signalEventsService.findAll(user.organizationId, queryDto);
  }

  @Delete(['events', 'org/:orgId/events'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Bulk delete signal events by IDs' })
  @ApiResponse({ status: 204, description: 'Events deleted successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error' })
  @ApiResponse({ status: 404, description: 'No matching events found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async bulkDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() deleteDto: DeleteSignalEventsDto,
  ) {
    await this.signalEventsService.bulkDelete(user.organizationId, deleteDto);
  }

  @Get(['events/needs-cost-backfill', 'org/:orgId/events/needs-cost-backfill'])
  @ApiOperation({ summary: 'List unknown-cost event groups awaiting model mapping' })
  @ApiResponse({
    status: 200,
    description: 'Returns event groups with unknown cost, grouped by (model, provider)',
  })
  async getNeedsCostBackfill(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: NeedsCostBackfillQueryDto,
  ) {
    return this.signalEventsService.getNeedsCostBackfill(user.organizationId, queryDto);
  }

  @Post(['events/map-model', 'org/:orgId/events/map-model'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Map an unknown model to a known one and backfill event costs',
  })
  @ApiResponse({
    status: 200,
    description: 'Model mapped and events backfilled',
  })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 404, description: 'Target pricing row not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async mapModel(@CurrentUser() user: AuthenticatedUser, @Body() dto: MapModelDto) {
    return this.signalEventsService.mapModel(user.organizationId, dto);
  }

  @Get(['events/missing-volume', 'org/:orgId/events/missing-volume'])
  @ApiOperation({ summary: 'List events with missing volume data, grouped by model' })
  @ApiResponse({
    status: 200,
    description: 'Returns event groups with missing volume, grouped by (model, provider)',
  })
  async getMissingVolume(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: MissingVolumeQueryDto,
  ) {
    return this.signalEventsService.getMissingVolumeGroups(user.organizationId, queryDto);
  }

  @Post(['events/fill-volume', 'org/:orgId/events/fill-volume'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Provide missing volume data and calculate costs for affected events',
  })
  @ApiResponse({
    status: 200,
    description: 'Volume data applied and costs calculated',
  })
  @ApiResponse({ status: 400, description: 'Wrong volume fields for service type' })
  @ApiResponse({ status: 404, description: 'Model not found in pricing table' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async fillVolume(@CurrentUser() user: AuthenticatedUser, @Body() dto: FillVolumeDto) {
    return this.signalEventsService.fillVolume(user.organizationId, dto);
  }

  @Get(['events/analytics', 'org/:orgId/events/analytics'])
  @ApiOperation({ summary: 'Get event ingestion analytics' })
  @ApiResponse({ status: 200, description: 'Returns event analytics data' })
  async getAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() queryDto: EventAnalyticsQueryDto,
  ) {
    return this.signalEventsService.getAnalytics(user.organizationId, queryDto);
  }
}
