import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PortalSessionUser } from '../auth/auth.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';

/**
 * Portal invoice response
 */
export interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate: Date;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  status: string;
  totalAmount: number;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  amountPaid: number;
  amountDue: number;
  currency: string;
  pdfUrl?: string;
  lineItems?: PortalInvoiceLineItem[];
}

/**
 * Portal invoice line item
 */
export interface PortalInvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

/**
 * Portal subscription response
 */
export interface PortalSubscription {
  id: string;
  name: string;
  status: string;
  startDate: Date;
  endDate?: Date;
  billingCycle: string;
  currentBillingPeriodStart?: Date;
  currentBillingPeriodEnd?: Date;
  plan: {
    id: string;
    name: string;
    description?: string;
  };
  agent: {
    id: string;
    name: string;
  };
}

/**
 * Portal profile response
 */
export interface PortalProfile {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  billingContactName?: string;
  billingContactEmail?: string;
  timezone?: string;
  currency: string;
}

/**
 * Portal activity summary. Carries no cost: end-customers see what their
 * agents did, not what it cost the merchant to produce.
 */
export interface PortalUsageSummary {
  period: {
    start: Date;
    end: Date;
  };
  totalTasks: number;
  totalUnits: number;
  byAgent: {
    agentId: string;
    agentName: string;
    taskCount: number;
    totalUnits: number;
  }[];
  bySignal: {
    signalId: string;
    signalName: string;
    taskCount: number;
    totalUnits: number;
  }[];
}

/**
 * Update profile DTO
 */
export interface UpdatePortalProfileDto {
  name?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  billingContactName?: string;
  billingContactEmail?: string;
  timezone?: string;
}

@Injectable()
export class PortalApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueMetrics: RevenueMetricsService,
  ) {}

  /**
   * Get current session info
   */
  async getSessionInfo(portalUser: PortalSessionUser) {
    const session = await this.prisma.portal_sessions.findUnique({
      where: { id: portalUser.sessionId },
      select: {
        id: true,
        expiresAt: true,
        createdAt: true,
        customers: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    return {
      id: session.id,
      customerId: session.customers?.id,
      customerName: session.customers?.name,
      customerEmail: session.customers?.email,
      expiresAt: session.expiresAt,
      features: ['invoices', 'subscriptions', 'usage', 'profile'],
      createdAt: session.createdAt,
    };
  }

  /**
   * Get customer profile
   */
  async getProfile(portalUser: PortalSessionUser): Promise<PortalProfile> {
    const customer = await this.prisma.customers.findUnique({
      where: { id: portalUser.customerId },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    return {
      id: customer.id,
      name: customer.name,
      email: customer.email || undefined,
      phone: customer.phone || undefined,
      addressLine1: customer.addressLine1 || undefined,
      addressLine2: customer.addressLine2 || undefined,
      city: customer.city || undefined,
      state: customer.state || undefined,
      zipCode: customer.zipCode || undefined,
      country: customer.country || undefined,
      billingContactName: customer.billingContactName || undefined,
      billingContactEmail: customer.billingContactEmail || undefined,
      timezone: customer.timezone || undefined,
      currency: customer.currency,
    };
  }

  /**
   * Update customer profile
   */
  async updateProfile(
    portalUser: PortalSessionUser,
    dto: UpdatePortalProfileDto,
  ): Promise<PortalProfile> {
    const customer = await this.prisma.customers.update({
      where: { id: portalUser.customerId },
      data: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        addressLine1: dto.addressLine1,
        addressLine2: dto.addressLine2,
        city: dto.city,
        state: dto.state,
        zipCode: dto.zipCode,
        country: dto.country,
        billingContactName: dto.billingContactName,
        billingContactEmail: dto.billingContactEmail,
        timezone: dto.timezone,
        updatedAt: new Date(),
      },
    });

    return {
      id: customer.id,
      name: customer.name,
      email: customer.email || undefined,
      phone: customer.phone || undefined,
      addressLine1: customer.addressLine1 || undefined,
      addressLine2: customer.addressLine2 || undefined,
      city: customer.city || undefined,
      state: customer.state || undefined,
      zipCode: customer.zipCode || undefined,
      country: customer.country || undefined,
      billingContactName: customer.billingContactName || undefined,
      billingContactEmail: customer.billingContactEmail || undefined,
      timezone: customer.timezone || undefined,
      currency: customer.currency,
    };
  }

  /**
   * List customer invoices
   */
  async listInvoices(
    portalUser: PortalSessionUser,
    options?: { limit?: number; status?: string },
  ): Promise<PortalInvoice[]> {
    const invoices = await this.prisma.invoices.findMany({
      where: {
        customerId: portalUser.customerId,
        deletedAt: null,
        ...(options?.status ? { status: options.status as any } : {}),
      },
      orderBy: { invoiceDate: 'desc' },
      take: options?.limit || 50,
    });

    return invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      billingPeriodStart: inv.billingPeriodStart,
      billingPeriodEnd: inv.billingPeriodEnd,
      status: inv.status || 'draft',
      totalAmount: parseFloat(inv.totalAmount.toString()),
      subtotal: parseFloat(inv.subtotal.toString()),
      taxAmount: parseFloat((inv.taxAmount || 0).toString()),
      discountAmount: parseFloat((inv.discountAmount || 0).toString()),
      amountPaid: parseFloat(inv.amountPaid.toString()),
      amountDue: parseFloat(inv.amountDue.toString()),
      currency: inv.currency,
      pdfUrl: inv.pdfUrl || undefined,
    }));
  }

  /**
   * Get single invoice with line items
   */
  async getInvoice(portalUser: PortalSessionUser, invoiceId: string): Promise<PortalInvoice> {
    const invoice = await this.prisma.invoices.findFirst({
      where: {
        id: invoiceId,
        customerId: portalUser.customerId,
        deletedAt: null,
      },
      include: {
        // A soft-deleted line is a charge the customer no longer owes. Showing
        // it here prints a breakdown that does not add up to the total beside it.
        invoice_line_items: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice not found: ${invoiceId}`);
    }

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      billingPeriodStart: invoice.billingPeriodStart,
      billingPeriodEnd: invoice.billingPeriodEnd,
      status: invoice.status || 'draft',
      totalAmount: parseFloat(invoice.totalAmount.toString()),
      subtotal: parseFloat(invoice.subtotal.toString()),
      taxAmount: parseFloat((invoice.taxAmount || 0).toString()),
      discountAmount: parseFloat((invoice.discountAmount || 0).toString()),
      amountPaid: parseFloat(invoice.amountPaid.toString()),
      amountDue: parseFloat(invoice.amountDue.toString()),
      currency: invoice.currency,
      pdfUrl: invoice.pdfUrl || undefined,
      lineItems: invoice.invoice_line_items.map((item) => ({
        id: item.id,
        description: item.description || '',
        quantity: parseFloat(item.quantity.toString()),
        unitPrice: parseFloat(item.unitPrice.toString()),
        amount: parseFloat(item.amount.toString()),
      })),
    };
  }

  /**
   * List customer subscriptions
   */
  async listSubscriptions(
    portalUser: PortalSessionUser,
    options?: { includeInactive?: boolean },
  ): Promise<PortalSubscription[]> {
    const subscriptions = await this.prisma.subscriptions.findMany({
      where: {
        customerId: portalUser.customerId,
        deletedAt: null,
        ...(options?.includeInactive ? {} : { status: 'active' }),
      },
      include: {
        pricing_plans: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
        agents: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return subscriptions.map((sub) => ({
      id: sub.id,
      name: sub.name,
      status: sub.status || 'pending',
      startDate: sub.startDate,
      endDate: sub.endDate || undefined,
      billingCycle: sub.billingCycle || 'monthly',
      currentBillingPeriodStart: sub.currentBillingPeriodStart || undefined,
      currentBillingPeriodEnd: sub.currentBillingPeriodEnd || undefined,
      plan: {
        id: sub.pricing_plans.id,
        name: sub.pricing_plans.name,
        description: sub.pricing_plans.description || undefined,
      },
      agent: {
        id: sub.agents.id,
        name: sub.agents.name,
      },
    }));
  }

  /**
   * Get activity summary for current billing period.
   *
   * End-customers see what their agents did, not what it cost the merchant
   * to produce, so this endpoint never reads cost: no cost data reaches the
   * customer-facing surface.
   *
   * Quantity aggregation via groupBy is allowed here (non-monetary; rule R9
   * in scripts/canonical-audit.sh only restricts `_sum: { usageCost }`).
   */
  async getUsageSummary(
    portalUser: PortalSessionUser,
    options?: { periodStart?: Date; periodEnd?: Date },
  ): Promise<PortalUsageSummary> {
    const now = new Date();
    const periodStart = options?.periodStart || new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd =
      options?.periodEnd || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const customer = await this.prisma.customers.findUnique({
      where: { id: portalUser.customerId },
      select: { organizationId: true },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const eventScope = {
      customerId: portalUser.customerId,
      organizationId: customer.organizationId,
      usageDate: { gte: periodStart, lte: periodEnd },
    };

    const [byAgentRows, bySignalRows, totalCount] = await Promise.all([
      this.prisma.signal_events.groupBy({
        by: ['agentId'],
        where: eventScope,
        _count: { _all: true },
        _sum: { quantity: true },
      }),
      this.prisma.signal_events.groupBy({
        by: ['signalId'],
        where: eventScope,
        _count: { _all: true },
        _sum: { quantity: true },
      }),
      this.prisma.signal_events.count({ where: eventScope }),
    ]);

    const agentIds = byAgentRows.map((r) => r.agentId);
    const signalIds = bySignalRows.map((r) => r.signalId).filter((id): id is string => !!id);

    const [agents, signals] = await Promise.all([
      agentIds.length > 0
        ? this.prisma.agents.findMany({
            where: { id: { in: agentIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      signalIds.length > 0
        ? this.prisma.signals.findMany({
            where: { id: { in: signalIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const agentNames = new Map(agents.map((a) => [a.id, a.name]));
    const signalNames = new Map(signals.map((s) => [s.id, s.name]));

    const byAgent = byAgentRows.map((row) => ({
      agentId: row.agentId,
      agentName: agentNames.get(row.agentId) || 'Unknown agent',
      taskCount: row._count._all,
      totalUnits: parseFloat((row._sum.quantity || 0).toString()),
    }));

    const bySignal = bySignalRows.map((row) => ({
      signalId: row.signalId ?? '',
      signalName: (row.signalId && signalNames.get(row.signalId)) || 'Activity',
      taskCount: row._count._all,
      totalUnits: parseFloat((row._sum.quantity || 0).toString()),
    }));

    const totalUnits = bySignal.reduce((sum, r) => sum + r.totalUnits, 0);

    return {
      period: { start: periodStart, end: periodEnd },
      totalTasks: totalCount,
      totalUnits,
      byAgent,
      bySignal,
    };
  }
}
