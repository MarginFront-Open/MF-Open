import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';
import moment from 'moment';
import puppeteer, { Page } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import * as handlebars from 'handlebars';
import * as os from 'os';
import { createCurrencyFormatter } from '../../common/utils/currency';
import { resolveProductName } from '../../common/config/app-config';
import { assertPublicResolvedHost, isSafePublicHttpsUrl } from './pdf-url-safety';

const DEFAULT_HEADER_COLOR = '#2B3990';
const DEFAULT_TEXT_COLOR = '#FFFFFF';
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function sanitizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : fallback;
}

function resolveAllowedLogoUrl(rawLogo: unknown): string | null {
  if (typeof rawLogo !== 'string' || !isSafePublicHttpsUrl(rawLogo)) {
    return null;
  }
  try {
    return new URL(rawLogo).toString();
  } catch {
    return null;
  }
}

/** One row of a stored line item's tier breakdown, as the writer persists it. */
interface StoredTierRow {
  lower: number;
  upper: number | null;
  rate: number;
  quantity: number;
  subtotal: number;
}

/**
 * The tier breakdown a stored line item carries, or nothing.
 *
 * `metadata` is a free-form Json column, so this must survive whatever is in
 * there — a string, a null, a half-written blob — without throwing inside PDF
 * generation. Anything that isn't a proper array of rows reads as "no
 * breakdown", never as a fabricated one.
 */
export function tierRowsFromMetadata(metadata: unknown): StoredTierRow[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const tiers = (metadata as { tiersUsed?: unknown }).tiersUsed;
  if (!Array.isArray(tiers)) return [];
  return tiers.filter(
    (row): row is StoredTierRow =>
      !!row && typeof row === 'object' && typeof (row as StoredTierRow).subtotal === 'number',
  );
}

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private readonly templateDir: string;
  private readonly invoiceTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.templateDir = path.join(process.cwd(), 'src', 'templates');
    this.invoiceTemplate = path.join(this.templateDir, 'invoice.hbs');

    handlebars.registerHelper('eq', function (a, b) {
      return a === b;
    });
  }

  /**
   * Render an invoice PDF to a local temp file.
   * @returns s3Location is the local temp-file path; s3Key is the object key the
   *   file would be uploaded under. Nothing is uploaded.
   */
  async generateInvoicePDF(
    invoice: any,
    calculationDetails?: any,
  ): Promise<{ s3Location: string; s3Key: string }> {
    try {
      if (!fs.existsSync(this.templateDir)) {
        await this._createTemplateFiles();
      }

      // Prefer associations already loaded on the invoice.
      const { customer, organization } = await this._resolveOrganizationAndCustomer(invoice);
      const allowedLogoUrl = resolveAllowedLogoUrl(organization?.logo);

      const htmlContent = await this._generateHTML(
        invoice,
        calculationDetails,
        organization,
        customer,
      );

      const tempFilePath = path.join(
        os.tmpdir(),
        `${invoice.invoiceNumber.replace(/[^a-zA-Z0-9-]/g, '_')}_${Date.now()}.pdf`,
      );

      await this._generatePDF(htmlContent, tempFilePath, allowedLogoUrl);

      // The PDF stays in a local temp file. To keep PDFs in object storage,
      // upload tempFilePath here under s3FileName and return that URL.
      const s3FileName = `invoices/${invoice.customerId}/${invoice.invoiceNumber.replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;

      this.logger.log(`Invoice PDF generated locally: ${tempFilePath}`);

      return {
        s3Location: tempFilePath,
        s3Key: s3FileName,
      };
    } catch (error) {
      this.logger.error('Error generating invoice PDF:', error);
      throw error;
    }
  }

  private async _resolveOrganizationAndCustomer(
    invoice: any,
  ): Promise<{ customer: any; organization: any }> {
    let customer = invoice.customer || null;
    let organization = invoice.organization || null;

    if (!organization && invoice.subscriptionId) {
      const subscription = await this.prisma.subscriptions.findUnique({
        where: { id: invoice.subscriptionId },
        include: {
          customers: {
            include: {
              organizations: true,
            },
          },
        },
      });

      if (subscription && subscription.customers && subscription.customers.organizations) {
        organization = subscription.customers.organizations;
        if (!customer && subscription.customers) {
          customer = subscription.customers;
        }
      }
    }

    if (!organization && invoice.organizationId) {
      organization = await this.prisma.organizations.findUnique({
        where: { id: invoice.organizationId },
      });
    }

    return { customer, organization };
  }

  /**
   * Enforce strict request interception on a Puppeteer page so only `about:blank`
   * and the single validated public HTTPS organization logo image may load.
   */
  private async attachSafeRequestInterceptor(
    page: Page,
    allowedLogoUrl: string | null,
  ): Promise<void> {
    await page.setRequestInterception(true);

    page.on('request', async (request) => {
      try {
        const url = request.url();
        if (url === 'about:blank') {
          await request.continue();
          return;
        }

        const isRedirect =
          typeof request.redirectChain === 'function' && request.redirectChain().length > 0;

        if (
          !isRedirect &&
          request.resourceType() === 'image' &&
          Boolean(allowedLogoUrl) &&
          url === allowedLogoUrl &&
          isSafePublicHttpsUrl(url)
        ) {
          const parsed = new URL(url);
          if (await assertPublicResolvedHost(parsed.hostname)) {
            await request.continue();
            return;
          }
        }

        this.logger.warn(`Blocked outbound PDF request: ${request.resourceType()} ${url}`);
        await request.abort('blockedbyclient');
      } catch {
        await request.abort('blockedbyclient').catch(() => undefined);
      }
    });
  }

  /**
   * Render the invoice Handlebars template to HTML.
   */
  private async _generateHTML(
    invoice: any,
    calculationDetails: any,
    organization: any,
    customer: any,
  ): Promise<string> {
    try {
      const templateSource = fs.readFileSync(this.invoiceTemplate, 'utf8');
      const template = handlebars.compile(templateSource);

      const data = this._prepareTemplateData(invoice, calculationDetails, organization, customer);

      const html = template(data);
      return html;
    } catch (error) {
      this.logger.error('Error generating HTML from template:', error);
      throw error;
    }
  }

  private async _renderPdfWithPuppeteer(
    htmlContent: string,
    allowedLogoUrl: string | null,
    outputPath?: string,
  ): Promise<Buffer> {
    let browser = null;

    try {
      const executablePath = await chromium.executablePath();

      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: chromium.headless,
      });

      const page = await browser.newPage();

      await page.setViewport({ width: 1440, height: 1600 });

      await this.attachSafeRequestInterceptor(page, allowedLogoUrl);

      await page.setContent(htmlContent, {
        waitUntil: ['networkidle0', 'domcontentloaded'],
        timeout: 30000,
      });

      // networkidle0 can settle before every <img> finishes; wait for each, and
      // hide any that fails so a broken logo never blocks the render.
      await page.evaluate(async () => {
        const selectors = Array.from(document.querySelectorAll('img'));

        await Promise.all(
          selectors.map((img) => {
            if ((img as HTMLImageElement).complete) {
              return Promise.resolve();
            }

            return new Promise((resolve) => {
              img.addEventListener('load', () => {
                resolve(null);
              });
              img.addEventListener('error', () => {
                (img as HTMLElement).style.display = 'none';
                resolve(null);
              });
            });
          }),
        );
      });

      const pdfBytes = await page.pdf({
        ...(outputPath ? { path: outputPath } : {}),
        format: 'A4',
        printBackground: true,
        margin: {
          top: '10mm',
          right: '10mm',
          bottom: '10mm',
          left: '10mm',
        },
      });

      return Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  private async _generatePDF(
    htmlContent: string,
    outputPath: string,
    allowedLogoUrl: string | null = null,
  ): Promise<void> {
    try {
      await this._renderPdfWithPuppeteer(htmlContent, allowedLogoUrl, outputPath);
      this.logger.debug('PDF generated successfully');
    } catch (error) {
      this.logger.error('Error generating PDF with Puppeteer:', error);
      throw error;
    }
  }

  private _prepareTemplateData(
    invoice: any,
    calculationDetails: any,
    organization: any,
    customer: any,
  ): any {
    const { metadata, ...invoiceData } = invoice;

    this.logger.debug('Organization data received:', {
      name: organization?.name,
      logo: organization?.logo,
      designjson: organization?.designjson,
    });

    const rawDesignJson =
      organization?.designjson &&
      typeof organization.designjson === 'object' &&
      !Array.isArray(organization.designjson)
        ? (organization.designjson as Record<string, unknown>)
        : {};
    const safeDesignJson = {
      headerColor: sanitizeHexColor(rawDesignJson.headerColor, DEFAULT_HEADER_COLOR),
      textColor: sanitizeHexColor(rawDesignJson.textColor, DEFAULT_TEXT_COLOR),
    };
    const safeLogo = resolveAllowedLogoUrl(organization?.logo) || '';

    // The organizations model uses snake_case for most columns.
    const organizationData = organization
      ? {
          name: organization.name,
          tagline: organization.tagline,
          addressLine1: organization.address_line1,
          addressLine2: organization.address_line2,
          city: organization.city,
          state: organization.state,
          zipCode: organization.zip_code,
          country: organization.country,
          billingEmail: organization.billing_email,
          billingPhone: organization.billing_phone,
          defaultCurrency: organization.default_currency,
          logo: safeLogo,
          designJson: safeDesignJson,
        }
      : {
          name: resolveProductName(this.configService),
          tagline: '',
          addressLine1: '',
          addressLine2: '',
          city: '',
          state: '',
          zipCode: '',
          country: '',
          billingEmail: '',
          billingPhone: '',
          defaultCurrency: 'USD',
          logo: '',
          designJson: safeDesignJson,
        };

    const formatCurrency = createCurrencyFormatter(organizationData.defaultCurrency);

    const customerData = customer
      ? {
          id: customer.id,
          externalId: customer.externalId,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          addressLine1: customer.addressLine1,
          addressLine2: customer.addressLine2,
          city: customer.city,
          state: customer.state,
          zipCode: customer.zipCode,
          country: customer.country,
          billingContactName: customer.billingContactName,
          billingContactEmail: customer.billingContactEmail,
          netTerms: customer.netTerms,
        }
      : {
          id: invoice.customerId,
          name: 'Unknown Customer',
        };

    const formattedInvoice = {
      ...invoiceData,
      invoiceDateFormatted: moment(invoice.invoiceDate).format('MMMM DD, YYYY'),
      dueDateFormatted: moment(invoice.dueDate).format('MMMM DD, YYYY'),
      billingPeriodStartFormatted: moment(invoice.billingPeriodStart).format('MMM DD, YYYY'),
      billingPeriodEndFormatted: moment(invoice.billingPeriodEnd).format('MMM DD, YYYY'),
      subtotalFormatted: formatCurrency(invoice.subtotal),
      totalAmountFormatted: formatCurrency(invoice.totalAmount),
      taxAmountFormatted: formatCurrency(invoice.taxAmount),
      discountAmountFormatted: formatCurrency(invoice.discountAmount),
      hasTax: invoice.taxAmount > 0,
      hasDiscount: invoice.discountAmount > 0,
      invoiceNumber: invoice.invoiceNumber || `INV-${Date.now()}`,
      status: invoice.status || 'draft',
    };

    let recurringItems = [];
    let usageItems = [];
    let onetimeItems = [];
    let seatBasedItems = [];
    const genericItems = [];

    // Line item sources, in order: lineItemsByType, flat lineItems, then the
    // invoice.items association.
    const lineItems =
      (metadata && metadata.lineItems) ||
      (calculationDetails && calculationDetails.lineItems) ||
      [];

    const lineItemsByType = (calculationDetails && calculationDetails.lineItemsByType) || {
      recurring: [],
      usage: [],
      onetime: [],
      seatBased: [],
    };

    const invoiceItemsFromAssociation = invoice.items || [];

    if (lineItemsByType.recurring && lineItemsByType.recurring.length > 0) {
      recurringItems = lineItemsByType.recurring.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        unitPriceFormatted: formatCurrency(item.unitPrice),
        amount: item.amount,
        amountFormatted: formatCurrency(item.amount),
        hasTiers: item.tiersUsed && item.tiersUsed.length > 0,
        tiersFormatted: (item.tiersUsed || []).map((tier) => ({
          lower: tier.lower,
          upper: tier.upper,
          upperFormatted: tier.upper === null ? 'infinity' : tier.upper,
          rate: tier.rate,
          rateFormatted: formatCurrency(tier.rate),
          quantity: tier.quantity,
          subtotal: tier.subtotal,
          subtotalFormatted: formatCurrency(tier.subtotal),
        })),
      }));
    }

    if (lineItemsByType.usage && lineItemsByType.usage.length > 0) {
      usageItems = lineItemsByType.usage.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.effectiveUnitPrice || item.unitPrice,
        unitPriceFormatted: formatCurrency(item.effectiveUnitPrice || item.unitPrice),
        amount: item.amount,
        amountFormatted: formatCurrency(item.amount),
        hasTiers: item.tiersUsed && item.tiersUsed.length > 0,
        tiersFormatted: (item.tiersUsed || []).map((tier) => ({
          lower: tier.lower,
          upper: tier.upper,
          upperFormatted: tier.upper === null ? 'infinity' : tier.upper,
          rate: tier.rate,
          rateFormatted: formatCurrency(tier.rate),
          quantity: tier.quantity,
          subtotal: tier.subtotal,
          subtotalFormatted: formatCurrency(tier.subtotal),
        })),
      }));
    }

    if (lineItemsByType.onetime && lineItemsByType.onetime.length > 0) {
      onetimeItems = lineItemsByType.onetime.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        unitPriceFormatted: formatCurrency(item.unitPrice),
        amount: item.amount,
        amountFormatted: formatCurrency(item.amount),
        hasTiers: item.tiersUsed && item.tiersUsed.length > 0,
        tiersFormatted: (item.tiersUsed || []).map((tier) => ({
          lower: tier.lower,
          upper: tier.upper,
          upperFormatted: tier.upper === null ? 'infinity' : tier.upper,
          rate: tier.rate,
          rateFormatted: formatCurrency(tier.rate),
          quantity: tier.quantity,
          subtotal: tier.subtotal,
          subtotalFormatted: formatCurrency(tier.subtotal),
        })),
      }));
    }

    if (lineItemsByType.seatBased && lineItemsByType.seatBased.length > 0) {
      seatBasedItems = lineItemsByType.seatBased.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        unitPriceFormatted: formatCurrency(item.unitPrice),
        amount: item.amount,
        amountFormatted: formatCurrency(item.amount),
        hasTiers: item.tiersUsed && item.tiersUsed.length > 0,
        tiersFormatted: (item.tiersUsed || []).map((tier) => ({
          lower: tier.lower,
          upper: tier.upper,
          upperFormatted: tier.upper === null ? 'infinity' : tier.upper,
          rate: tier.rate,
          rateFormatted: formatCurrency(tier.rate),
          quantity: tier.quantity,
          subtotal: tier.subtotal,
          subtotalFormatted: formatCurrency(tier.subtotal),
        })),
        pricingModel: item.pricingModel,
        minimumCommitment: item.minimumCommitment,
        isMinimumCommitmentApplied: item.isMinimumCommitmentApplied,
        actualQuantity: item.actualQuantity,
      }));
    }

    if ((!lineItemsByType || Object.keys(lineItemsByType).length === 0) && lineItems.length > 0) {
      lineItems.forEach((item) => {
        const formattedItem = {
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice || item.effectiveUnitPrice,
          unitPriceFormatted: formatCurrency(item.unitPrice || item.effectiveUnitPrice),
          amount: item.amount,
          amountFormatted: formatCurrency(item.amount),
          hasTiers: item.tiersUsed && item.tiersUsed.length > 0,
          tiersFormatted: (item.tiersUsed || []).map((tier) => ({
            lower: tier.lower,
            upper: tier.upper,
            upperFormatted: tier.upper === null ? 'infinity' : tier.upper,
            rate: tier.rate,
            rateFormatted: formatCurrency(tier.rate),
            quantity: tier.quantity,
            subtotal: tier.subtotal,
            subtotalFormatted: formatCurrency(tier.subtotal),
          })),
          pricingModel: item.pricingModel,
          minimumCommitment: item.minimumCommitment,
          isMinimumCommitmentApplied: item.isMinimumCommitmentApplied,
          actualQuantity: item.actualQuantity,
        };

        if (item.chargeType === 'recurring') {
          recurringItems.push(formattedItem);
        } else if (item.chargeType === 'usage') {
          usageItems.push(formattedItem);
        } else if (item.chargeType === 'onetime') {
          onetimeItems.push(formattedItem);
        } else if (item.chargeType === 'seat_based') {
          seatBasedItems.push(formattedItem);
        }
      });
    }

    const hasNoItems =
      recurringItems.length === 0 &&
      usageItems.length === 0 &&
      onetimeItems.length === 0 &&
      seatBasedItems.length === 0;

    if (hasNoItems && invoiceItemsFromAssociation.length > 0) {
      this.logger.debug('Using invoice.items association for PDF line items', {
        itemCount: invoiceItemsFromAssociation.length,
      });

      invoiceItemsFromAssociation.forEach((item) => {
        // A stored row keeps its tier breakdown inside metadata (the writer
        // puts it there: common/utils/invoice/invoice.utils.ts). Without it a
        // persisted invoice prints "400 × $0.25 = $99.00" with no explanation
        // of a blended price the per-unit column cannot express.
        const tiers = tierRowsFromMetadata(item.metadata);
        const formattedItem = {
          description: item.description,
          quantity: parseFloat(item.quantity.toString()) || 1,
          unitPrice: parseFloat(item.unitPrice.toString()) || 0,
          unitPriceFormatted: formatCurrency(parseFloat(item.unitPrice.toString()) || 0),
          amount: parseFloat(item.amount.toString()) || 0,
          amountFormatted: formatCurrency(parseFloat(item.amount.toString()) || 0),
          hasTiers: tiers.length > 0,
          tiersFormatted: tiers.map((tier) => ({
            lower: tier.lower,
            upper: tier.upper,
            upperFormatted: tier.upper === null ? 'infinity' : tier.upper,
            rate: tier.rate,
            rateFormatted: formatCurrency(tier.rate),
            quantity: tier.quantity,
            subtotal: tier.subtotal,
            subtotalFormatted: formatCurrency(tier.subtotal),
          })),
        };

        const itemType = item.type || 'generic';

        if (itemType === 'recurring' || itemType === 'subscription') {
          recurringItems.push(formattedItem);
        } else if (itemType === 'usage') {
          usageItems.push(formattedItem);
        } else if (itemType === 'onetime' || itemType === 'one-time') {
          onetimeItems.push(formattedItem);
        } else if (itemType === 'seat_based') {
          seatBasedItems.push(formattedItem);
        } else {
          genericItems.push(formattedItem);
        }
      });
    }

    return {
      invoice: formattedInvoice,
      organization: organizationData,
      customer: customerData,
      calculationDetails,
      hasRecurringItems: recurringItems.length > 0,
      hasUsageItems: usageItems.length > 0,
      hasOnetimeItems: onetimeItems.length > 0,
      hasSeatBasedItems: seatBasedItems.length > 0,
      hasGenericItems: genericItems.length > 0,
      recurringItems,
      usageItems,
      onetimeItems,
      seatBasedItems,
      genericItems,
      currentYear: new Date().getFullYear(),
    };
  }

  private async _createTemplateFiles(): Promise<void> {
    try {
      if (!fs.existsSync(this.templateDir)) {
        fs.mkdirSync(this.templateDir, { recursive: true });
      }

      if (!fs.existsSync(this.invoiceTemplate)) {
        this.logger.warn(
          'Invoice template not found. Please ensure invoice.hbs exists in src/templates/',
        );
        throw new Error('Invoice template file not found');
      }

      this.logger.log('Template files checked successfully');
    } catch (error) {
      this.logger.error('Error creating template files:', error);
      throw error;
    }
  }

  /**
   * Render an invoice PDF and return it as a buffer, writing no file.
   */
  async generateInvoicePDFBuffer(invoice: any, calculationDetails?: any): Promise<Buffer> {
    try {
      if (!fs.existsSync(this.templateDir)) {
        await this._createTemplateFiles();
      }

      // Prefer associations already loaded on the invoice, as generateInvoicePDF does.
      const { customer, organization } = await this._resolveOrganizationAndCustomer(invoice);
      const allowedLogoUrl = resolveAllowedLogoUrl(organization?.logo);

      const htmlContent = await this._generateHTML(
        invoice,
        calculationDetails,
        organization,
        customer,
      );

      const pdfBuffer = await this._renderPdfWithPuppeteer(htmlContent, allowedLogoUrl);

      this.logger.log(
        'PDF buffer generated successfully for invoice:',
        invoice.invoiceNumber || invoice.id,
      );

      return pdfBuffer;
    } catch (error) {
      this.logger.error('Error generating PDF buffer:', error);
      throw error;
    }
  }
}
