import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiResponse } from '@nestjs/swagger';
import { FiltersService } from './filters.service';
import { GetFiltersDto } from './filters.dto';
// This route genuinely acts on the org named in the URL, so the guard must run in
// its default URL-param mode. Do NOT add @OrgFromUser here. It makes the guard judge the
// CALLER'S own org (see OrgRoleGuard) while the handler below still binds
// @Param('orgId') and hands that to the service — so the guard clears org B, the service serves
// org A, and a cross-org request gets a 200 carrying the VICTIM org's data. That is the exact
// leak, not a harmless self-read.
import { OrgRoleGuard, OrgRoles } from '../../common/guards/org-role.guard';
import { OrgIdParamUuidGuard } from '../../common/guards/org-id-param-uuid.guard';

@ApiTags('Filters')
@Controller('org/:orgId/filters')
@ApiBearerAuth()
export class FiltersController {
  constructor(private readonly filtersService: FiltersService) {}

  @Get()
  // Order is execution order. OrgIdParamUuidGuard has to run first: OrgRoleGuard queries a
  // @db.Uuid column with whatever the URL says, so a malformed id becomes a Prisma P2023 and
  // then a 500 in Sentry. A ParseUUIDPipe on the param below cannot prevent that, because
  // guards run before pipes.
  @UseGuards(OrgIdParamUuidGuard, OrgRoleGuard)
  @OrgRoles()
  @ApiOperation({
    summary: 'Get filter data for dropdowns (agents, customers, plans, signals, subscriptions)',
  })
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiResponse({
    status: 400,
    description: 'The organization id in the URL is not a valid id',
  })
  @ApiResponse({
    status: 403,
    description: 'The caller is not a member of the requested organization',
  })
  async getFilters(@Param('orgId') orgId: string, @Query() query: GetFiltersDto) {
    return this.filtersService.getFilters(orgId, query);
  }
}
