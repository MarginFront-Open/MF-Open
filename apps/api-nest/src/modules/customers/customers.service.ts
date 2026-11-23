import { randomUUID } from 'crypto';
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCustomerDto, UpdateCustomerDto, QueryCustomerDto } from './dto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async createCustomer(orgId: string, dto: CreateCustomerDto) {
    // If timezone is not provided, inherit from organization
    let timezone = dto.timezone || 'UTC';

    if (!dto.timezone) {
      const organization = await this.prisma.organizations.findUnique({
        where: { id: orgId },
      });

      if (organization) {
        timezone = organization.timezone || 'UTC';
      }
    }

    try {
      return await this.prisma.customers.create({
        data: {
          id: this.generateUuid(),
          organizationId: orgId,
          name: dto.name,
          externalId: dto.externalId || null,
          email: dto.email || null,
          phone: dto.phone || null,
          addressLine1: dto.addressLine1 || null,
          addressLine2: dto.addressLine2 || null,
          city: dto.city || null,
          state: dto.state || null,
          zipCode: dto.zipCode || null,
          country: dto.country || null,
          timezone,
          status: (dto.status || 'active') as any,
          billingContactName: dto.billingContactName || null,
          billingContactEmail: dto.billingContactEmail || null,
          netTerms: dto.netTerms ?? 30,
          invoiceEmailRecipients: dto.invoiceEmailRecipients || [],
          metadata: dto.metadata || {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException(
          'A customer with that externalId already exists in this organization.',
        );
      }
      throw error;
    }
  }

  async getCustomers(orgId: string, query: QueryCustomerDto) {
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc', ...filters } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      organizationId: orgId,
      deletedAt: null,
    };

    if (filters.name) {
      where.name = { contains: filters.name, mode: 'insensitive' };
    }

    if (filters.email) {
      where.email = { contains: filters.email, mode: 'insensitive' };
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.timezone) {
      where.timezone = filters.timezone;
    }

    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { externalId: { contains: filters.search, mode: 'insensitive' } },
        { billingContactName: { contains: filters.search, mode: 'insensitive' } },
        { timezone: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [customers, totalResults] = await Promise.all([
      this.prisma.customers.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          subscriptions: {
            where: { status: 'active' },
            take: 1,
            select: { id: true, status: true },
          },
        },
      }),
      this.prisma.customers.count({ where }),
    ]);

    // status reports whether the customer has an active subscription, not the stored column.
    const results = customers.map((customer) => {
      const { subscriptions, ...customerData } = customer as any;
      return {
        ...customerData,
        status: subscriptions && subscriptions.length > 0 ? 'active' : 'inactive',
      };
    });

    return {
      results,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  async getCustomerById(customerId: string, orgId: string) {
    const customer = await this.prisma.customers.findFirst({
      where: {
        id: customerId,
        organizationId: orgId,
        deletedAt: null,
      },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    return customer;
  }

  async updateCustomer(customerId: string, orgId: string, dto: UpdateCustomerDto) {
    // Org-scoped lookup: another org's customer id 404s before the update by id.
    await this.getCustomerById(customerId, orgId);

    // If timezone is being explicitly set to null/empty, inherit from organization
    let timezone = dto.timezone;
    if (dto.hasOwnProperty('timezone') && !dto.timezone) {
      const organization = await this.prisma.organizations.findUnique({
        where: { id: orgId },
      });
      if (organization) {
        timezone = organization.timezone || 'UTC';
      }
    }

    return this.prisma.customers.update({
      where: { id: customerId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.externalId !== undefined && { externalId: dto.externalId }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.addressLine1 !== undefined && { addressLine1: dto.addressLine1 }),
        ...(dto.addressLine2 !== undefined && { addressLine2: dto.addressLine2 }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(dto.state !== undefined && { state: dto.state }),
        ...(dto.zipCode !== undefined && { zipCode: dto.zipCode }),
        ...(dto.country !== undefined && { country: dto.country }),
        ...(timezone !== undefined && { timezone }),
        ...(dto.status && { status: dto.status as any }),
        ...(dto.billingContactName !== undefined && { billingContactName: dto.billingContactName }),
        ...(dto.billingContactEmail !== undefined && {
          billingContactEmail: dto.billingContactEmail,
        }),
        ...(dto.netTerms !== undefined && { netTerms: dto.netTerms }),
        ...(dto.invoiceEmailRecipients && { invoiceEmailRecipients: dto.invoiceEmailRecipients }),
        ...(dto.metadata && { metadata: dto.metadata }),
        updatedAt: new Date(),
      },
    });
  }

  async deleteCustomer(customerId: string, orgId: string) {
    await this.getCustomerById(customerId, orgId);

    return this.prisma.customers.update({
      where: { id: customerId },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  private generateUuid(): string {
    return randomUUID();
  }
}
