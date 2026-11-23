import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateSignalDto } from './dto/create-signal.dto';
import { UpdateSignalDto } from './dto/update-signal.dto';
import { QuerySignalDto } from './dto/query-signal.dto';
import { BulkSignalDto } from './dto/bulk-signal.dto';
import { ClassifySignalDto } from './dto/classify-signal.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class SignalsService {
  private readonly logger = new Logger(SignalsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, createSignalDto: CreateSignalDto) {
    this.logger.log(`Creating signal for organization: ${organizationId}`);

    const agent = await this.prisma.agents.findFirst({
      where: {
        id: createSignalDto.agentId,
        orgId: organizationId,
        deletedAt: null,
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    try {
      const signal = await this.prisma.signals.create({
        data: {
          id: uuidv4(),
          name: createSignalDto.name,
          shortName: createSignalDto.shortName || null,
          agentId: createSignalDto.agentId,
          orgId: organizationId,
          type: createSignalDto.type as any,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return signal;
    } catch (error: any) {
      if (error.code === 'P2002') {
        const fields = error.meta?.target as string[] | undefined;
        const field = fields?.includes('shortName') ? 'shortName' : 'name';
        throw new ConflictException(`A signal with that ${field} already exists for this agent.`);
      }
      throw error;
    }
  }

  async bulkCreateOrUpdate(organizationId: string, bulkSignalDto: BulkSignalDto) {
    this.logger.log(`Bulk create/update signals for organization: ${organizationId}`);

    const { signals } = bulkSignalDto;

    const uniqueAgentIds = [...new Set(signals.map((s) => s.agentId))];

    if (uniqueAgentIds.length > 0) {
      const agents = await this.prisma.agents.findMany({
        where: {
          id: { in: uniqueAgentIds },
          orgId: organizationId,
          deletedAt: null,
        },
      });

      if (agents.length !== uniqueAgentIds.length) {
        const foundAgentIds = agents.map((a) => a.id);
        const missingAgentIds = uniqueAgentIds.filter((id) => !foundAgentIds.includes(id));
        throw new NotFoundException(`Agents not found: ${missingAgentIds.join(', ')}`);
      }
    }

    const newSignals = signals.filter((s) => s.isNew);
    const updateSignals = signals.filter((s) => !s.isNew);

    if (updateSignals.length > 0) {
      const updateIds = updateSignals.map((s) => s.id).filter(Boolean) as string[];

      const existingSignals = await this.prisma.signals.findMany({
        where: {
          id: { in: updateIds },
          orgId: organizationId,
          deletedAt: null,
        },
      });

      if (existingSignals.length !== updateIds.length) {
        const foundIds = existingSignals.map((s) => s.id);
        const missingIds = updateIds.filter((id) => !foundIds.includes(id));
        throw new NotFoundException(`Signals not found: ${missingIds.join(', ')}`);
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const createdSignals: any[] = [];
      const updatedSignals: any[] = [];

      for (const signalData of newSignals) {
        const { isNew: _isNew, id: _id, ...data } = signalData;
        const created = await tx.signals.create({
          data: {
            id: uuidv4(),
            name: data.name,
            shortName: data.shortName || null,
            agentId: data.agentId,
            orgId: organizationId,
            type: data.type as any,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        createdSignals.push(created);
      }

      for (const signalData of updateSignals) {
        const { isNew: _isNew, id, ...data } = signalData;
        if (!id) {
          throw new BadRequestException('Signal ID is required for updates');
        }

        const updateData: any = {
          updatedAt: new Date(),
        };

        if (data.name !== undefined) updateData.name = data.name;
        if (data.shortName !== undefined) updateData.shortName = data.shortName || null;
        if (data.agentId !== undefined) updateData.agentId = data.agentId;
        if (data.type !== undefined) updateData.type = data.type;
        const updated = await tx.signals.update({
          where: { id },
          data: updateData,
        });
        updatedSignals.push(updated);
      }

      return [...createdSignals, ...updatedSignals];
    });

    return result;
  }

  async findAll(organizationId: string, queryDto: QuerySignalDto) {
    this.logger.log(`Querying signals for organization: ${organizationId}`);

    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc', ...filters } = queryDto;

    const skip = (page - 1) * limit;

    const where: any = {
      orgId: organizationId,
      deletedAt: null,
    };

    if (filters.name) {
      where.name = { contains: filters.name, mode: 'insensitive' };
    }

    if (filters.agentId) {
      where.agentId = filters.agentId;
    }

    if (filters.type) {
      where.type = filters.type;
    }

    const [signals, totalResults] = await Promise.all([
      this.prisma.signals.findMany({
        where,
        include: {
          agents: {
            select: {
              id: true,
              name: true,
              agentCode: true,
            },
          },
        },
        orderBy: {
          [sortBy]: sortOrder,
        },
        skip,
        take: limit,
      }),
      this.prisma.signals.count({ where }),
    ]);

    // Response shape: the `agents` relation exposed as `agent`.
    const results = signals.map((signal) => ({
      ...signal,
      agent: signal.agents,
      agents: undefined,
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
    this.logger.log(`Finding signal ${id} for organization ${organizationId}`);

    const signal = await this.prisma.signals.findFirst({
      where: {
        id,
        orgId: organizationId,
        deletedAt: null,
      },
      include: {
        agents: {
          select: {
            id: true,
            name: true,
            agentCode: true,
          },
        },
      },
    });

    if (!signal) {
      throw new NotFoundException('Signal not found');
    }

    // Response shape: the `agents` relation exposed as `agent`.
    return {
      ...signal,
      agent: signal.agents,
      agents: undefined,
    };
  }

  async update(id: string, organizationId: string, updateSignalDto: UpdateSignalDto) {
    this.logger.log(`Updating signal ${id} for organization ${organizationId}`);

    await this.findOne(id, organizationId);

    if (updateSignalDto.agentId) {
      const agent = await this.prisma.agents.findFirst({
        where: {
          id: updateSignalDto.agentId,
          orgId: organizationId,
          deletedAt: null,
        },
      });

      if (!agent) {
        throw new NotFoundException('Agent not found');
      }
    }

    const updateData: any = {
      updatedAt: new Date(),
    };

    if (updateSignalDto.name !== undefined) updateData.name = updateSignalDto.name;
    if (updateSignalDto.shortName !== undefined)
      updateData.shortName = updateSignalDto.shortName || null;
    if (updateSignalDto.agentId !== undefined) updateData.agentId = updateSignalDto.agentId;
    if (updateSignalDto.type !== undefined) updateData.type = updateSignalDto.type;
    const updatedSignal = await this.prisma.signals.update({
      where: { id },
      data: updateData,
    });

    return updatedSignal;
  }

  /**
   * Set the accounting cost classification (COGS vs R&D etc.) for a signal.
   *
   * This is a single-purpose mutation kept separate from the generic update()
   * path so the dashboard can wire it to one specific UI control (the
   * classification dropdown).
   *
   * The auto-classifier in sdk.service.recordUsage only runs when a signal
   * is still UNCLASSIFIED. Once a human (or this endpoint) sets a value,
   * the auto-classifier does not overwrite it.
   */
  async classify(id: string, organizationId: string, dto: ClassifySignalDto) {
    this.logger.log(`Classifying signal ${id} as ${dto.costCategory} for org ${organizationId}`);

    await this.findOne(id, organizationId);

    const updated = await this.prisma.signals.update({
      where: { id },
      data: { costCategory: dto.costCategory, updatedAt: new Date() } as any,
    });

    return updated;
  }

  async remove(id: string, organizationId: string) {
    this.logger.log(`Deleting signal ${id} for organization ${organizationId}`);

    await this.findOne(id, organizationId);

    await this.prisma.signals.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return { message: 'Signal deleted successfully' };
  }
}
