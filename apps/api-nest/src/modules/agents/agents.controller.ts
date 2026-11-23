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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiSecurity,
} from '@nestjs/swagger';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { QueryAgentDto } from './dto/query-agent.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
// An agent is the metering plumbing (which model it runs, what it meters)
// — a BUILD/operations record, not the books. Its create/update/delete writes are gated to
// Manage-BUILD roles (owner/admin) in the caller's OWN org, matching the dashboard
// agent Server Actions. @OrgFromUser because the service scopes every write to
// user.organizationId (the :orgId alias is ignored). Reads (GET) stay open. Same-org API
// keys still pass the guard (within-org SDK traffic); plain human members are blocked.
import { OrgRoleGuard, OrgRoles, OrgFromUser } from '../../common/guards/org-role.guard';
import { MANAGE_BUILD_ROLES } from '@marginfront/db';

// Canonical:    /v1/agents
// Alias:        /v1/org/:orgId/agents
// orgId is always taken from the authenticated user, never from the URL.
@ApiTags('Agents')
@Controller()
@ApiBearerAuth()
@ApiSecurity('api-key')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post(['agents', 'org/:orgId/agents'])
  @ApiOperation({ summary: 'Create a new agent' })
  @ApiResponse({ status: 201, description: 'Agent created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 409, description: 'Agent with this code already exists' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() createAgentDto: CreateAgentDto) {
    const agent = await this.agentsService.create(user.organizationId, createAgentDto);
    return agent;
  }

  @Get(['agents', 'org/:orgId/agents'])
  @ApiOperation({ summary: 'Get all agents with pagination and filters' })
  @ApiResponse({ status: 200, description: 'List of agents retrieved successfully' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Results per page (default: 10, max: 100)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search across name, description, and agent code',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['name', 'agentCode', 'createdAt', 'updatedAt'],
    description: 'Sort by field',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort order (default: desc)',
  })
  async findAll(@CurrentUser() user: AuthenticatedUser, @Query() queryDto: QueryAgentDto) {
    return this.agentsService.findAll(user.organizationId, queryDto);
  }

  @Get(['agents/:id', 'org/:orgId/agents/:id'])
  @ApiOperation({ summary: 'Get agent by ID' })
  @ApiResponse({ status: 200, description: 'Agent retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentsService.findOne(id, user.organizationId);
  }

  @Patch(['agents/:id', 'org/:orgId/agents/:id'])
  @ApiOperation({ summary: 'Update agent by ID' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @ApiResponse({ status: 409, description: 'Agent with this code already exists' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() updateAgentDto: UpdateAgentDto,
  ) {
    const result = await this.agentsService.update(id, user.organizationId, updateAgentDto);
    return result;
  }

  @Delete(['agents/:id', 'org/:orgId/agents/:id'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete agent by ID (soft delete)' })
  @ApiResponse({ status: 204, description: 'Agent deleted successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @UseGuards(OrgRoleGuard)
  @OrgRoles(...MANAGE_BUILD_ROLES)
  @OrgFromUser()
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const result = await this.agentsService.remove(id, user.organizationId);
    return result;
  }
}
