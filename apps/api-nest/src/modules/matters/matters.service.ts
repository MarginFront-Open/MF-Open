/**
 * WHAT THIS FILE DOES: The REST twin of the Law tab's server actions
 * — matters CRUD with real per-matter cost, the Unassigned list,
 * manual event assignment, routing-rule CRUD + the apply-rules sweep, and the
 * org-wide audit view. Every query mirrors its dashboard original so an MCP
 * agent and a human at the dashboard see the same numbers.
 *
 * WHY IT EXISTS: the Law tab runs on dashboard Server Actions, which the MCP
 * server can't reach. This service re-implements those queries because the
 * actions embed session concerns and can't be imported. DRIFT RISK, accepted: if you change a query
 * here or in the dashboard actions, change the twin — the audit-parity spec
 * pins the math, not the queries.
 *
 * CONNECTS TO: apps/dashboard/app/actions/matters.ts, matter-rules.ts,
 * matter-export.ts (the originals, cited per method), matters-audit.util.ts
 * (window + grouping), matters.controller.ts (the /v1 surface).
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getMatterCostRollups } from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  buildMatterAudit,
  parseAuditWindow,
  type MatterAudit,
  type MatterSource,
} from './matters-audit.util';
import {
  AssignEventDto,
  CreateMatterDto,
  CreateMatterRuleDto,
  MatterAuditQueryDto,
  MatterListQueryDto,
  UpdateMatterDto,
  UpdateMatterRuleDto,
} from './dto';

/** Mirrors the dashboard's MatterEventRow (matters.ts): null usageCost means
 * "not yet resolved", surfaced as null, never 0. */
export interface MatterEventRow {
  eventId: string;
  usageDate: string;
  agentName: string;
  signalName: string;
  quantity: number | null;
  usageCost: number | null;
  source: MatterSource | null;
}

/** What the default format=summary call actually returns: everything but the
 * per-event rows. Typed here (not in the util) so the util stays an untouched
 * port of the dashboard's export builder. */
export type MatterAuditSummary = Omit<MatterAudit, 'rows'>;

/** The dashboard detail view caps at the 100 most recent events; the audit
 * endpoint is the full-record surface. Mirrored here and stated in the
 * response as `eventsCap`. */
const DETAIL_EVENTS_CAP = 100;

const EVENT_SELECT = {
  id: true,
  usageDate: true,
  quantity: true,
  usageCost: true,
  matterSource: true,
  agents: { select: { name: true } },
  signals: { select: { name: true } },
} satisfies Prisma.signal_eventsSelect;

const toNum = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d));

function serializeEvent(ev: {
  id: string;
  usageDate: Date;
  quantity: Prisma.Decimal | null;
  usageCost: Prisma.Decimal | null;
  matterSource: string | null;
  agents: { name: string };
  signals: { name: string } | null;
}): MatterEventRow {
  return {
    eventId: ev.id,
    usageDate: ev.usageDate.toISOString(),
    agentName: ev.agents.name,
    signalName: ev.signals?.name ?? '(no signal)',
    quantity: toNum(ev.quantity),
    usageCost: toNum(ev.usageCost),
    source: (ev.matterSource as MatterSource | null) ?? null,
  };
}

/** Trim to null so an all-whitespace matcher can never match everything
 * (twin of matter-rules.ts normalizeMatcher). */
function normalizeMatcher(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function serializeMatter(m: {
  id: string;
  matterNumber: string;
  name: string;
  clientName: string;
  status: string;
  responsibleUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: m.id,
    matterNumber: m.matterNumber,
    name: m.name,
    clientName: m.clientName,
    status: m.status,
    responsibleUserId: m.responsibleUserId,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

function serializeRule(r: {
  id: string;
  matterId: string;
  priority: number;
  agentCode: string | null;
  customerExternalId: string | null;
  signalPattern: string | null;
  matters: { matterNumber: string; name: string };
}) {
  return {
    id: r.id,
    matterId: r.matterId,
    matterNumber: r.matters.matterNumber,
    matterName: r.matters.name,
    priority: r.priority,
    agentCode: r.agentCode,
    customerExternalId: r.customerExternalId,
    signalPattern: r.signalPattern,
  };
}

@Injectable()
export class MattersService {
  private readonly logger = new Logger(MattersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Twin of getMatters (matters.ts): one rollup call (getMatterCostRollups),
   * no N+1, scoped to the returned page. */
  async listMatters(orgId: string, query: MatterListQueryDto) {
    const { page = 1, limit = 10 } = query;
    const where = { orgId };

    const [matters, totalResults] = await Promise.all([
      this.prisma.matters.findMany({
        where,
        orderBy: [{ status: 'asc' }, { matterNumber: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.matters.count({ where }),
    ]);

    const rollups = matters.length
      ? await getMatterCostRollups(this.prisma, orgId, {
          matterIds: matters.map((m) => m.id),
        })
      : [];
    const rollupByMatter = new Map(rollups.map((r) => [r.matterId, r]));

    return {
      results: matters.map((m) => ({
        ...serializeMatter(m),
        actualCost: rollupByMatter.get(m.id)?.cost ?? 0,
        eventCount: rollupByMatter.get(m.id)?.eventCount ?? 0,
        eventsMissingCost: rollupByMatter.get(m.id)?.eventsMissingCost ?? 0,
      })),
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  /** Twin of getMatterDetail (matters.ts): the matter, its all-time cost
   * and count, and its most recent 100 events. */
  async getMatterDetail(orgId: string, matterId: string) {
    const matter = await this.prisma.matters.findFirst({ where: { id: matterId, orgId } });
    if (!matter) {
      throw new NotFoundException('Matter not found in this organization.');
    }

    const [events, [rollup]] = await Promise.all([
      this.prisma.signal_events.findMany({
        where: { organizationId: orgId, matterId },
        select: EVENT_SELECT,
        orderBy: { usageDate: 'desc' },
        take: DETAIL_EVENTS_CAP,
      }),
      // Zero-filled by contract: the requested bucket always comes back.
      getMatterCostRollups(this.prisma, orgId, { matterIds: [matterId] }),
    ]);

    return {
      matter: serializeMatter(matter),
      actualCost: rollup.cost,
      eventCount: rollup.eventCount,
      // Events with unresolved cost add 0 to actualCost and must surface
      // here, never silently zero.
      eventsMissingCost: rollup.eventsMissingCost,
      events: events.map(serializeEvent),
      eventsCap: DETAIL_EVENTS_CAP,
    };
  }

  /** Twin of upsertMatter's create half (matters.ts), same messages. */
  async createMatter(orgId: string, dto: CreateMatterDto) {
    const data = this.validateMatterFields({
      matterNumber: dto.matterNumber,
      name: dto.name,
      clientName: dto.clientName,
    });

    try {
      const created = await this.prisma.matters.create({
        data: {
          orgId,
          ...data,
          status: dto.status ?? 'open',
          responsibleUserId: dto.responsibleUserId ?? null,
        },
      });
      return serializeMatter(created);
    } catch (err) {
      this.rethrowDuplicateMatterNumber(err, data.matterNumber);
    }
  }

  /** Twin of upsertMatter's update half (matters.ts), PATCH semantics:
   * only provided fields change. */
  async updateMatter(orgId: string, matterId: string, dto: UpdateMatterDto) {
    const provided = this.validateMatterFields(
      {
        matterNumber: dto.matterNumber,
        name: dto.name,
        clientName: dto.clientName,
      },
      { partial: true },
    );

    const data: Prisma.mattersUpdateManyMutationInput = { ...provided };
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.responsibleUserId !== undefined) data.responsibleUserId = dto.responsibleUserId;

    try {
      const updated = await this.prisma.matters.updateMany({
        where: { id: matterId, orgId },
        data,
      });
      if (updated.count === 0) {
        throw new NotFoundException('Matter not found in this organization.');
      }
    } catch (err) {
      this.rethrowDuplicateMatterNumber(err, provided.matterNumber ?? '');
    }

    const matter = await this.prisma.matters.findFirst({ where: { id: matterId, orgId } });
    return serializeMatter(matter!);
  }

  /**
   * Twin of deleteMatter (matters.ts). The transaction clears matterSource
   * on the matter's events (the FK's onDelete: SetNull clears matterId), so
   * every event returns to Unassigned re-sweepable; the matter's routing rules
   * are deleted in the same transaction (the FK's onDelete: Cascade would do it
   * anyway, schema.prisma matter_routing_rules.matterId). The response states both.
   */
  async deleteMatter(orgId: string, matterId: string) {
    const matter = await this.prisma.matters.findFirst({
      where: { id: matterId, orgId },
      select: { id: true },
    });
    if (!matter) {
      throw new NotFoundException('Matter not found in this organization.');
    }

    // The explicit deleteMany duplicates the FK cascade on purpose: running it
    // inside the transaction makes its count exactly what this delete removed,
    // where a count() taken outside could misreport under concurrent rule edits.
    const [eventsUpdated, rulesDeleted] = await this.prisma.$transaction([
      this.prisma.signal_events.updateMany({
        where: { organizationId: orgId, matterId },
        data: { matterSource: null },
      }),
      this.prisma.matter_routing_rules.deleteMany({ where: { matterId, orgId } }),
      this.prisma.matters.delete({ where: { id: matterId } }),
    ]);

    return {
      deleted: true,
      eventsReturnedToUnassigned: eventsUpdated.count,
      routingRulesDeleted: rulesDeleted.count,
    };
  }

  /** Twin of getUnassignedCount + getUnassignedEvents (matters.ts).
   * totalResults is the badge count: no date window, so it can never read
   * zero while unassigned events exist anywhere in history. */
  async getUnassigned(orgId: string, query: MatterListQueryDto) {
    const { page = 1, limit = 10 } = query;
    const where = { organizationId: orgId, matterId: null };

    const [events, [rollup]] = await Promise.all([
      this.prisma.signal_events.findMany({
        where,
        select: EVENT_SELECT,
        orderBy: { usageDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      // matterIds: [null] = the Unassigned bucket; zero-filled by contract.
      getMatterCostRollups(this.prisma, orgId, { matterIds: [null] }),
    ]);

    return {
      results: events.map(serializeEvent),
      page,
      limit,
      totalPages: Math.ceil(rollup.eventCount / limit),
      totalResults: rollup.eventCount,
      totalCost: rollup.cost,
      // The same needs-attention companion the audit endpoint carries.
      eventsMissingCost: rollup.eventsMissingCost,
    };
  }

  /** Twin of assignEventToMatter (matters.ts): manual assignment, the top
   * of the precedence order. matterId null unassigns, still stamped 'manual'
   * so apply-rules never re-sweeps an operator's explicit unassignment. */
  async assignEvent(orgId: string, dto: AssignEventDto) {
    if (dto.matterId !== null) {
      const matter = await this.prisma.matters.findFirst({
        where: { id: dto.matterId, orgId },
        select: { id: true },
      });
      if (!matter) {
        throw new NotFoundException('Matter not found in this organization.');
      }
    }

    // updateMany scoped by org so a foreign event id is a no-op, not a leak.
    const updated = await this.prisma.signal_events.updateMany({
      where: { id: dto.eventId, organizationId: orgId },
      data: { matterId: dto.matterId, matterSource: 'manual' },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Usage event not found in this organization.');
    }

    return { assigned: true, eventId: dto.eventId, matterId: dto.matterId, source: 'manual' };
  }

  /** Twin of getMatterRules (matter-rules.ts): EVALUATION order — priority
   * asc, ties by createdAt then id — the same ORDER BY the ingest loader and
   * the apply sweep use. */
  async listRules(orgId: string, query: MatterListQueryDto) {
    const { page = 1, limit = 10 } = query;
    const where = { orgId };

    const [rules, totalResults] = await Promise.all([
      this.prisma.matter_routing_rules.findMany({
        where,
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: { matters: { select: { matterNumber: true, name: true } } },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.matter_routing_rules.count({ where }),
    ]);

    return {
      results: rules.map(serializeRule),
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  /** Twin of upsertMatterRule's create half (matter-rules.ts), same
   * messages and the same at-least-one-matcher requirement. */
  async createRule(orgId: string, dto: CreateMatterRuleDto) {
    const matchers = this.validateRuleMatchers({
      agentCode: normalizeMatcher(dto.agentCode),
      customerExternalId: normalizeMatcher(dto.customerExternalId),
      signalPattern: normalizeMatcher(dto.signalPattern),
    });

    await this.assertMatterInOrg(orgId, dto.matterId);

    const created = await this.prisma.matter_routing_rules.create({
      data: {
        orgId,
        matterId: dto.matterId,
        priority: dto.priority ?? 100,
        ...matchers,
      },
      include: { matters: { select: { matterNumber: true, name: true } } },
    });
    return serializeRule(created);
  }

  /** Twin of upsertMatterRule's update half, PATCH semantics: an omitted
   * matcher keeps its value, an explicit null clears it, and the merged rule
   * must still carry at least one matcher. */
  async updateRule(orgId: string, ruleId: string, dto: UpdateMatterRuleDto) {
    const existing = await this.prisma.matter_routing_rules.findFirst({
      where: { id: ruleId, orgId },
    });
    if (!existing) {
      throw new NotFoundException('Rule not found in this organization.');
    }

    const merged = this.validateRuleMatchers({
      agentCode: dto.agentCode !== undefined ? normalizeMatcher(dto.agentCode) : existing.agentCode,
      customerExternalId:
        dto.customerExternalId !== undefined
          ? normalizeMatcher(dto.customerExternalId)
          : existing.customerExternalId,
      signalPattern:
        dto.signalPattern !== undefined
          ? normalizeMatcher(dto.signalPattern)
          : existing.signalPattern,
    });

    if (dto.matterId !== undefined && dto.matterId !== existing.matterId) {
      await this.assertMatterInOrg(orgId, dto.matterId);
    }

    const updated = await this.prisma.matter_routing_rules.update({
      where: { id: ruleId },
      data: {
        ...merged,
        ...(dto.matterId !== undefined ? { matterId: dto.matterId } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      },
      include: { matters: { select: { matterNumber: true, name: true } } },
    });
    return serializeRule(updated);
  }

  /** Twin of deleteMatterRule (matter-rules.ts). */
  async deleteRule(orgId: string, ruleId: string) {
    const deleted = await this.prisma.matter_routing_rules.deleteMany({
      where: { id: ruleId, orgId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException('Rule not found in this organization.');
    }
    return { deleted: true };
  }

  /**
   * Twin of applyMatterRulesToUnassigned (matter-rules.ts). Scope is
   * (matterId IS NULL AND matterSource IS NULL) on purpose: never overrides a
   * tag/rule/manual assignment, never re-sweeps a manual unassignment.
   * Priority order holds across rules because an earlier rule's updateMany
   * takes its matches out of the null set before the next rule runs. On a
   * mid-sweep failure the earlier rules' updates are already committed —
   * mirroring the dashboard, the error names the partial count and says to
   * run it again.
   */
  async applyRules(orgId: string) {
    let assigned = 0;
    let ruleInFlight: string | null = null;
    try {
      const rules = await this.prisma.matter_routing_rules.findMany({
        where: { orgId },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });

      for (const rule of rules) {
        if (!rule.agentCode && !rule.customerExternalId && !rule.signalPattern) {
          continue;
        }
        ruleInFlight = rule.id;
        const result = await this.prisma.signal_events.updateMany({
          where: {
            organizationId: orgId,
            matterId: null,
            matterSource: null,
            ...(rule.agentCode ? { agents: { agentCode: rule.agentCode } } : {}),
            ...(rule.customerExternalId ? { customerExternalId: rule.customerExternalId } : {}),
            ...(rule.signalPattern
              ? {
                  signals: {
                    name: { contains: rule.signalPattern, mode: 'insensitive' },
                  },
                }
              : {}),
          },
          data: { matterId: rule.matterId, matterSource: 'rule' },
        });
        assigned += result.count;
      }
    } catch (err) {
      // An HttpException 500 is "expected" to Sentry, unlogged by Nest, and
      // ignored by the customer-failure filter, so this line is the ONLY server
      // trace of a partial sweep failure. The dashboard twin logs too.
      this.logger.error(
        `apply-rules sweep failed for org ${orgId}` +
          (ruleInFlight ? ` on rule ${ruleInFlight}` : ' while fetching rules') +
          `; ${assigned} events assigned before the error`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException({
        statusCode: 500,
        assigned,
        message:
          assigned > 0
            ? `Stopped partway: ${assigned} events were assigned before the error. Run it again to finish the rest.`
            : "Couldn't apply the rules. Nothing changed. Try again.",
      });
    }

    return { assigned };
  }

  /**
   * Twin of getMatterExport (matter-export.ts). RECONCILIATION CONTRACT:
   * the unfiltered where-clause is organizationId + usageDate
   * {gte, lte} inclusive and NOTHING else, so matters + Unassigned sums to
   * the org's cost headline for the window and the summary matches the
   * dashboard CSV row for row. The optional matterId slice is deliberately a
   * different surface — it verifies the matter first and drops the
   * reconciliation rows (no Unassigned, matter-only totals).
   */
  async getAudit(
    orgId: string,
    query: MatterAuditQueryDto,
  ): Promise<MatterAudit | MatterAuditSummary> {
    const { windowStart, windowEnd } = parseAuditWindow(query);

    if (query.matterId) {
      await this.assertMatterInOrg(orgId, query.matterId);
    }

    const events = await this.prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: windowStart, lte: windowEnd },
        ...(query.matterId ? { matterId: query.matterId } : {}),
      },
      select: {
        id: true,
        usageDate: true,
        quantity: true,
        usageCost: true,
        matterSource: true,
        agents: { select: { name: true } },
        signals: { select: { name: true } },
        signal_event_services: { select: { model: true } },
        matters: { select: { matterNumber: true, name: true, clientName: true } },
      },
    });

    const audit = buildMatterAudit(
      events.map((ev) => ({
        id: ev.id,
        usageDate: ev.usageDate,
        quantity: toNum(ev.quantity),
        usageCost: toNum(ev.usageCost),
        matterSource: (ev.matterSource as MatterSource | null) ?? null,
        agentName: ev.agents.name,
        signalName: ev.signals?.name ?? '(no signal)',
        models: ev.signal_event_services.map((svc) => svc.model),
        matter: ev.matters,
      })),
      windowStart,
      windowEnd,
    );

    if ((query.format ?? 'summary') === 'summary') {
      const { rows: _rows, ...summaryOnly } = audit;
      return summaryOnly;
    }
    return audit;
  }

  private async assertMatterInOrg(orgId: string, matterId: string): Promise<void> {
    const matter = await this.prisma.matters.findFirst({
      where: { id: matterId, orgId },
      select: { id: true },
    });
    if (!matter) {
      throw new NotFoundException('Matter not found in this organization.');
    }
  }

  /** The dashboard's trim/required/255 checks (matters.ts), same
   * messages. With partial=true, absent fields are skipped (PATCH); without
   * it every field is required, which the create overload's type reflects. */
  private validateMatterFields(fields: {
    matterNumber?: string;
    name?: string;
    clientName?: string;
  }): { matterNumber: string; name: string; clientName: string };
  private validateMatterFields(
    fields: { matterNumber?: string; name?: string; clientName?: string },
    opts: { partial: true },
  ): { matterNumber?: string; name?: string; clientName?: string };
  private validateMatterFields(
    fields: { matterNumber?: string; name?: string; clientName?: string },
    opts: { partial: boolean } = { partial: false },
  ): { matterNumber?: string; name?: string; clientName?: string } {
    const out: { matterNumber?: string; name?: string; clientName?: string } = {};
    const specs = [
      ['Matter number', 'matterNumber', fields.matterNumber, 'Matter number is required.'],
      ['Matter name', 'name', fields.name, 'Matter name is required.'],
      ['Client name', 'clientName', fields.clientName, 'Client name is required.'],
    ] as const;

    for (const [label, key, raw, requiredMessage] of specs) {
      if (raw === undefined) {
        if (!opts.partial) throw new BadRequestException(requiredMessage);
        continue;
      }
      const value = raw.trim();
      if (!value) throw new BadRequestException(requiredMessage);
      if (value.length > 255) {
        throw new BadRequestException(`${label} must be 255 characters or fewer.`);
      }
      out[key] = value;
    }
    return out;
  }

  /** The dashboard's at-least-one-matcher + 255 checks (matter-rules.ts),
   * same messages. Takes already-normalized matchers. */
  private validateRuleMatchers(matchers: {
    agentCode: string | null;
    customerExternalId: string | null;
    signalPattern: string | null;
  }) {
    if (!matchers.agentCode && !matchers.customerExternalId && !matchers.signalPattern) {
      throw new BadRequestException(
        'A rule needs at least one matcher: an agent code, a customer ID, or a signal name pattern.',
      );
    }
    for (const [label, value] of [
      ['Agent code', matchers.agentCode],
      ['Customer ID', matchers.customerExternalId],
      ['Signal pattern', matchers.signalPattern],
    ] as const) {
      if (value && value.length > 255) {
        throw new BadRequestException(`${label} must be 255 characters or fewer.`);
      }
    }
    return matchers;
  }

  /** P2002 = unique-constraint violation; raw Prisma messages name models and
   * columns, so nothing else from err reaches the response (matters.ts). */
  private rethrowDuplicateMatterNumber(err: unknown, matterNumber: string): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictException(
        `A matter numbered "${matterNumber}" already exists in this organization.`,
      );
    }
    throw err;
  }
}
