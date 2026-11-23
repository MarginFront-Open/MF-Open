import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { QueryAgentDto } from './dto/query-agent.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, createAgentDto: CreateAgentDto) {
    this.logger.log(`Creating agent for organization: ${organizationId}`);

    try {
      const agent = await this.prisma.agents.create({
        data: {
          id: uuidv4(),
          name: createAgentDto.name,
          description: createAgentDto.description,
          agentCode: createAgentDto.agentCode,
          orgId: organizationId,
          isActive: createAgentDto.isActive ?? true,
          context: createAgentDto.context
            ? (createAgentDto.context as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return agent;
    } catch (error: any) {
      // Handle unique constraint violations (duplicate agent code)
      if (error.code === 'P2002') {
        throw new ConflictException(`Agent with code '${createAgentDto.agentCode}' already exists`);
      }
      throw error;
    }
  }

  async findAll(organizationId: string, queryDto: QueryAgentDto) {
    this.logger.log(`Querying agents for organization: ${organizationId}`);

    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      search,
      ...filters
    } = queryDto;

    const skip = (page - 1) * limit;

    const where: any = {
      orgId: organizationId,
      deletedAt: null,
    };

    if (filters.name) {
      where.name = { contains: filters.name, mode: 'insensitive' };
    }

    if (filters.agentCode) {
      where.agentCode = { contains: filters.agentCode, mode: 'insensitive' };
    }

    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { agentCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [agents, totalResults] = await Promise.all([
      this.prisma.agents.findMany({
        where,
        include: {
          _count: {
            select: {
              signals: true,
              agent_pricing_plans: true,
              subscriptions: true,
            },
          },
        },
        orderBy: {
          [sortBy]: sortOrder,
        },
        skip,
        take: limit,
      }),
      this.prisma.agents.count({ where }),
    ]);

    const results = agents.map((agent) => ({
      ...agent,
      signalsCount: agent._count.signals,
      activePlansCount: agent._count.agent_pricing_plans,
      activeSubscriptionsCount: agent._count.subscriptions,
      _count: undefined,
    }));

    return {
      results,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  async findOne(id: string, organizationId: string) {
    this.logger.log(`Finding agent ${id} for organization ${organizationId}`);

    const agent = await this.prisma.agents.findFirst({
      where: {
        id,
        orgId: organizationId,
        deletedAt: null,
      },
      include: {
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
            type: true,
          },
        },
        agent_pricing_plans: {
          include: {
            pricing_plans: {
              select: {
                id: true,
                name: true,
                isActive: true,
              },
            },
          },
        },
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    // Flatten the junction rows so consumers get pricing_plans as a plain array.
    return {
      ...agent,
      pricing_plans: agent.agent_pricing_plans.map((link) => link.pricing_plans),
      agent_pricing_plans: undefined,
    };
  }

  async update(id: string, organizationId: string, updateAgentDto: UpdateAgentDto) {
    this.logger.log(`Updating agent ${id} for organization ${organizationId}`);

    await this.findOne(id, organizationId);

    try {
      const updatedAgent = await this.prisma.agents.update({
        where: { id },
        data: {
          name: updateAgentDto.name,
          description: updateAgentDto.description,
          agentCode: updateAgentDto.agentCode,
          isActive: updateAgentDto.isActive,
          context: updateAgentDto.context as Prisma.InputJsonValue | undefined,
          updatedAt: new Date(),
        },
      });

      return updatedAgent;
    } catch (error: any) {
      // P2002: unique constraint violation (duplicate agent code).
      if (error.code === 'P2002') {
        throw new ConflictException(`Agent with code '${updateAgentDto.agentCode}' already exists`);
      }
      throw error;
    }
  }

  async remove(id: string, organizationId: string) {
    this.logger.log(`Deleting agent ${id} for organization ${organizationId}`);

    await this.findOne(id, organizationId);

    await this.prisma.agents.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return { message: 'Agent deleted successfully' };
  }
}
