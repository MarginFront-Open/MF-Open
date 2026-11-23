import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import Firecrawl from '@mendable/firecrawl-js';
import OpenAI from 'openai';
import { isPublicHostname } from '../../common/helpers/public-host';
import { isSafePublicHttpsUrl } from '../pdf/pdf-url-safety';

function sanitizeLogoUrl(rawLogo: unknown): string | null {
  return typeof rawLogo === 'string' && isSafePublicHttpsUrl(rawLogo) ? rawLogo : null;
}
import {
  EnhancedPreviewDto,
  EnhancedPreviewResponseDto,
  ScreenshotDto,
  ScreenshotResponseDto,
  CreateFromPreviewDto,
  CreateFromPreviewResponseDto,
  WebsiteOnboardingDto,
  QuickOnboardingDto,
  ExtractDataDto,
  ExtractDataResponseDto,
  PreviewBillingDto,
} from './dto';

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);
  private readonly firecrawl: any | null;
  private readonly openai: OpenAI | null;
  private readonly firecrawlApiKey: string;
  private readonly openaiApiKey: string;
  private readonly openaiModel: string;
  private readonly firecrawlTimeout: number;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this.firecrawlApiKey = this.config.get('FIRECRAWL_API_KEY') || '';
    this.openaiApiKey = this.config.get('OPENAI_API_KEY') || '';
    this.openaiModel = this.config.get('OPENAI_MODEL') || 'gpt-4o-2024-08-06';
    this.firecrawlTimeout = parseInt(this.config.get('FIRECRAWL_TIMEOUT_MS') || '30000', 10);

    if (!this.firecrawlApiKey) {
      this.logger.warn('FIRECRAWL_API_KEY not configured');
    }
    if (!this.openaiApiKey) {
      this.logger.warn('OPENAI_API_KEY not configured');
    }

    this.firecrawl = this.firecrawlApiKey ? new Firecrawl({ apiKey: this.firecrawlApiKey }) : null;
    this.openai = this.openaiApiKey ? new OpenAI({ apiKey: this.openaiApiKey }) : null;
  }

  async getScreenshot(dto: ScreenshotDto): Promise<ScreenshotResponseDto> {
    if (!this.firecrawl) {
      this.logger.warn('Screenshot skipped - Firecrawl not configured');
      return { screenshotUrl: null };
    }

    const normalizedUrl = this.normalizeUrl(dto.websiteUrl);
    this.logger.log(`Getting screenshot for: ${normalizedUrl}`);

    try {
      // Screenshot capture is slow, so it gets 45 seconds.
      const response: any = await this.withTimeout(
        this.firecrawl.scrape(normalizedUrl, {
          formats: ['screenshot'],
          timeout: 45000,
        }),
        45000,
        'Screenshot capture timed out',
      );

      const result = response?.data || response;
      const screenshotUrl = result?.screenshot || null;

      if (!screenshotUrl) {
        this.logger.warn(`No screenshot returned for ${normalizedUrl}, returning null`);
        // A missing screenshot is not fatal: the client renders without one.
        return { screenshotUrl: null };
      }

      return { screenshotUrl };
    } catch (error: any) {
      this.logger.error(`Screenshot capture failed: ${error.message}`);
      return { screenshotUrl: null };
    }
  }

  async enhancedPreview(dto: EnhancedPreviewDto): Promise<EnhancedPreviewResponseDto> {
    const normalizedUrl = this.normalizeUrl(dto.websiteUrl);
    this.logger.log(`Enhanced preview for: ${normalizedUrl}`);

    try {
      const websiteData = await this.scrapeWebsite(normalizedUrl);
      const { companyInfo, markdown: websiteMarkdown } = websiteData;

      let pricingMarkdown = '';
      const pricingPageUrl = await this.findPricingPage(normalizedUrl, websiteMarkdown);

      if (pricingPageUrl) {
        const pricingData = await this.scrapePricingPage(pricingPageUrl);
        pricingMarkdown = pricingData.markdown;
      }

      const [pricingData] = await Promise.all([
        this.analyzePricing({
          companyName: companyInfo.name,
          companyDescription: companyInfo.description,
          pricingMarkdown,
          websiteMarkdown,
        }),
      ]);

      const customers = await this.generateCustomers({
        companyName: companyInfo.name,
        companyDescription: companyInfo.description,
        pricingTiers: pricingData.pricingTiers,
        count: dto.customerCount || 4,
      });

      const pricingTiers = pricingData.pricingTiers || [];
      const signals = pricingData.signals || [];
      const agents = pricingData.agents || [];

      const transformedTiers = pricingTiers.map((tier, index) => ({
        ...tier,
        id: `tier-${index}`,
        enabled: true,
        price: tier.basePrice,
      }));

      const transformedSignals = signals.map((signal, index) => ({
        ...signal,
        id: `signal-${index}`,
        enabled: true,
      }));

      // Prefer paid tiers for customer assignment (skip free/enterprise with $0 price)
      const paidTiers = pricingTiers.filter((t) => (t.basePrice ?? 0) > 0 && !t.isEnterprise);
      const assignableTiers = paidTiers.length > 0 ? paidTiers : pricingTiers;

      const transformedCustomers = customers.map((customer, index) => ({
        ...customer,
        id: `customer-${index}`,
        enabled: true,
        assignedPlan: assignableTiers[index % assignableTiers.length]?.name || 'Starter',
      }));

      return {
        success: true,
        websiteUrl: normalizedUrl,
        pricingPageUrl: pricingPageUrl || null,
        companyInfo: {
          name: companyInfo.name,
          description: companyInfo.description,
          logo: sanitizeLogoUrl(companyInfo.logo),
          website: companyInfo.website,
          screenshotUrl: companyInfo.screenshotUrl,
        },
        pricingData: {
          tiers: transformedTiers,
          signals: transformedSignals,
          serviceCosts: [],
        },
        customers: transformedCustomers,
        agents: agents,
        summary: {
          pricingTiersCount: transformedTiers.length,
          signalsCount: transformedSignals.length,
          serviceCostsCount: 0,
          customersCount: transformedCustomers.length,
        },
        message: `Successfully analyzed ${companyInfo.name}`,
      };
    } catch (error: any) {
      this.logger.error(`Enhanced preview failed: ${error.message}`);
      throw new HttpException(
        `Failed to generate preview: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * CANONICAL STATUS:
   *   No revenue, cost or invoice math runs on this path. It inserts plain
   *   rows into organizations, agents, signals, pricing_plans,
   *   agent_pricing_plans, pricing_strategies, customers and subscriptions.
   *   Creating a subscription here generates no invoice and writes no
   *   dollar projection.
   */
  async createFromPreview(dto: CreateFromPreviewDto): Promise<CreateFromPreviewResponseDto> {
    this.logger.log(`Creating from preview for org: ${dto.organizationId}`);

    try {
      const org = await this.prisma.organizations.findUnique({
        where: { id: dto.organizationId },
      });

      if (!org) {
        throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);
      }

      const result = await this.prisma.$transaction(async (tx) => {
        const updatedOrg = await tx.organizations.update({
          where: { id: dto.organizationId },
          data: {
            name: dto.previewData.companyInfo.name,
            website: dto.previewData.companyInfo.website,
            logo: sanitizeLogoUrl(dto.previewData?.companyInfo?.logo),
            onboarding_complete: true,
            updatedAt: new Date(),
          },
        });

        const createdAgents: any[] = [];
        for (const agent of dto.previewData.agents) {
          const created = await tx.agents.create({
            data: {
              id: this.generateUuid(),
              orgId: dto.organizationId,
              name: agent.name,
              agentCode: agent.agentCode,
              description: agent.description,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
          createdAgents.push(created);
        }

        const createdSignals: any[] = [];
        const signals = dto.previewData.pricingData?.signals || [];
        for (const signal of signals) {
          const agent = createdAgents.find((a) => a.agentCode === signal.agentCode);
          if (agent) {
            const created = await tx.signals.create({
              data: {
                id: this.generateUuid(),
                orgId: dto.organizationId,
                agentId: agent.id,
                name: signal.name,
                shortName: signal.shortName,
                type: signal.type,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });
            createdSignals.push(created);
          }
        }

        const createdPlans: any[] = [];
        const tiers = dto.previewData.pricingData?.tiers || [];
        for (const tier of tiers) {
          // Every tier attaches to the first agent.
          const agent = createdAgents[0];
          if (agent) {
            const plan = await tx.pricing_plans.create({
              data: {
                id: this.generateUuid(),
                orgId: dto.organizationId,
                name: tier.name,
                description: tier.description || `${tier.name} plan`,
                featuresList: tier.features || [],
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });

            await tx.agent_pricing_plans.create({
              data: {
                agentId: agent.id,
                planId: plan.id,
              },
            });

            // Strategies are per agent, one per signal.
            for (const signal of createdSignals) {
              await tx.pricing_strategies.create({
                data: {
                  id: this.generateUuid(),
                  planId: plan.id,
                  orgId: dto.organizationId,
                  agentId: agent.id,
                  signalId: signal.id,
                  name: `${plan.name} - ${signal.name}`,
                  chargeType: 'recurring',
                  billingFrequency: tier.billingCycle as 'monthly' | 'yearly',
                  pricingModel: 'flat',
                  rate: tier.basePrice ?? tier.price ?? 0,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              });
            }

            createdPlans.push(plan);
          }
        }

        const createdCustomers: any[] = [];
        const customers = dto.previewData.customers || [];
        if (customers && customers.length > 0) {
          for (let i = 0; i < customers.length; i++) {
            const customer = customers[i];
            const customerId = this.generateUuid();
            const created = await tx.customers.create({
              data: {
                id: customerId,
                organizationId: dto.organizationId,
                externalId: `customer-${this.generateUuid().substring(0, 8)}`,
                name: customer.name,
                email: customer.email,
                phone: customer.phone || null,
                timezone: 'UTC',
                status: 'active',
                metadata: {},
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });
            createdCustomers.push(created);

            const matchingPlan = createdPlans[i % createdPlans.length];
            const firstAgent = createdAgents[0];
            if (matchingPlan && firstAgent) {
              const startDate = new Date();
              const nextInvoiceDate = new Date(startDate);
              nextInvoiceDate.setMonth(nextInvoiceDate.getMonth() + 1);
              const billingPeriodEnd = new Date(startDate);
              billingPeriodEnd.setMonth(billingPeriodEnd.getMonth() + 1);

              await tx.subscriptions.create({
                data: {
                  id: this.generateUuid(),
                  organizationId: dto.organizationId,
                  customerId,
                  planId: matchingPlan.id,
                  agentId: firstAgent.id,
                  name: `${customer.name} - ${matchingPlan.name}`,
                  status: 'active',
                  startDate,
                  billingCycle: 'monthly',
                  billingModel: 'usage',
                  currentBillingPeriodStart: startDate,
                  currentBillingPeriodEnd: billingPeriodEnd,
                  nextRecurringInvoiceAt: nextInvoiceDate,
                  nextUsageInvoiceAt: nextInvoiceDate,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                } as any,
              });
            }
          }
        }

        return {
          organization: updatedOrg,
          agents: createdAgents,
          signals: createdSignals,
          pricingPlans: createdPlans,
          customers: createdCustomers,
        };
      });

      return {
        organization: result.organization,
        agents: result.agents,
        signals: result.signals,
        pricingPlans: result.pricingPlans,
        customers: result.customers,
        summary: {
          agentsCreated: result.agents.length,
          signalsCreated: result.signals.length,
          plansCreated: result.pricingPlans.length,
          customersCreated: result.customers.length,
        },
      };
    } catch (error: any) {
      this.logger.error(`Create from preview failed: ${error.message}`);
      throw new HttpException(
        `Failed to create from preview: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async extractCompanyData(dto: ExtractDataDto): Promise<ExtractDataResponseDto> {
    this.logger.log(`Extracting company data from: ${dto.websiteUrl}`);

    try {
      const websiteData = await this.scrapeWebsite(dto.websiteUrl);

      return {
        success: true,
        data: {
          name: websiteData.companyInfo.name,
          description: websiteData.companyInfo.description,
          logo: sanitizeLogoUrl(websiteData.companyInfo.logo),
          website: websiteData.companyInfo.website,
        },
      };
    } catch (error: any) {
      this.logger.error(`Extract company data failed: ${error.message}`);
      throw new HttpException(
        `Failed to extract company data: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async previewBillingSetup(dto: PreviewBillingDto): Promise<any> {
    this.logger.log(`Preview billing for: ${dto.websiteUrl}`);

    try {
      return this.enhancedPreview({ websiteUrl: dto.websiteUrl, customerCount: 4 });
    } catch (error: any) {
      this.logger.error(`Preview billing failed: ${error.message}`);
      throw new HttpException(
        `Failed to preview billing: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async onboardFromWebsite(dto: WebsiteOnboardingDto): Promise<any> {
    this.logger.log(`Onboarding from website: ${dto.websiteUrl}`);

    try {
      const preview = await this.enhancedPreview({
        websiteUrl: dto.websiteUrl,
        customerCount: 4,
      });

      if (dto.skipBilling) {
        await this.prisma.organizations.update({
          where: { id: dto.organizationId },
          data: {
            name: preview.companyInfo.name,
            website: preview.companyInfo.website,
            logo: sanitizeLogoUrl(preview.companyInfo?.logo),
            updatedAt: new Date(),
          },
        });

        return { success: true, companyInfo: preview.companyInfo };
      }

      return this.createFromPreview({
        organizationId: dto.organizationId,
        previewData: {
          companyInfo: preview.companyInfo,
          pricingData: preview.pricingData,
          customers: preview.customers,
          agents: preview.agents,
        },
      });
    } catch (error: any) {
      this.logger.error(`Onboard from website failed: ${error.message}`);
      throw new HttpException(
        `Failed to onboard: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async quickOnboard(dto: QuickOnboardingDto): Promise<any> {
    this.logger.log(`Quick onboarding for org: ${dto.organizationId}`);

    try {
      const org = await this.prisma.organizations.findUnique({
        where: { id: dto.organizationId },
      });

      if (!org) {
        throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);
      }

      const agent = await this.prisma.agents.create({
        data: {
          id: this.generateUuid(),
          orgId: dto.organizationId,
          name: org.name,
          agentCode: org.name.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
          description: `${org.name} agent`,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      const signals = await Promise.all([
        this.prisma.signals.create({
          data: {
            id: this.generateUuid(),
            orgId: dto.organizationId,
            agentId: agent.id,
            name: 'API Requests',
            shortName: 'api_requests',
            type: 'usage',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
        this.prisma.signals.create({
          data: {
            id: this.generateUuid(),
            orgId: dto.organizationId,
            agentId: agent.id,
            name: 'Users',
            shortName: 'users',
            type: 'usage',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ]);

      await this.prisma.organizations.update({
        where: { id: dto.organizationId },
        data: { onboarding_complete: true },
      });

      return {
        success: true,
        agent,
        signals,
        message: 'Quick onboarding complete',
      };
    } catch (error: any) {
      this.logger.error(`Quick onboard failed: ${error.message}`);
      throw new HttpException(
        `Failed to quick onboard: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private generateUuid(): string {
    return crypto.randomUUID();
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(errorMessage)), ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
  }

  private normalizeUrl(url: string): string {
    if (!url) return url;
    if (!url.match(/^https?:\/\//i)) {
      return `https://${url}`;
    }
    return url;
  }

  private extractCompanyNameFromUrl(url: string): string {
    try {
      const normalizedUrl = this.normalizeUrl(url);
      const urlObj = new URL(normalizedUrl);
      const hostname = urlObj.hostname.replace('www.', '');
      const parts = hostname.split('.');
      const name = parts[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
      return 'Company';
    }
  }

  private async scrapeWebsite(url: string): Promise<any> {
    if (!this.firecrawl) {
      this.logger.warn('Website scraping skipped - Firecrawl not configured');
      return this.extractFallbackInfo(this.normalizeUrl(url));
    }

    const normalizedUrl = this.normalizeUrl(url);
    this.logger.log(`Scraping website: ${normalizedUrl}`);

    try {
      const response: any = await this.withTimeout(
        this.firecrawl.scrape(normalizedUrl, { formats: ['markdown', 'html'] }),
        this.firecrawlTimeout,
        'Website scraping timed out',
      );

      const result = response?.data || response;

      if (!result || !result.markdown) {
        this.logger.warn(`Scrape failed for ${normalizedUrl}, using fallback`);
        return this.extractFallbackInfo(normalizedUrl);
      }

      const metadata = result.metadata || {};
      const hostname = new URL(normalizedUrl).hostname;

      let companyName = metadata.ogSiteName || this.extractCompanyNameFromUrl(normalizedUrl);
      companyName = companyName
        .replace(/\s*(Home|Homepage|Official|Website|Site|Pricing|Plans)$/i, '')
        .trim();

      let logo = metadata.favicon || metadata.ogImage || null;
      if (logo && typeof logo === 'string' && !logo.startsWith('http')) {
        logo = `https://${hostname}${logo.startsWith('/') ? '' : '/'}${logo}`;
      }
      if (!logo || !isSafePublicHttpsUrl(logo)) {
        logo = `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
      }
      logo = sanitizeLogoUrl(logo);

      const description = metadata.ogDescription || metadata.description || '';

      return {
        url: normalizedUrl,
        hostname,
        markdown: result.markdown || '',
        html: result.html || '',
        metadata,
        companyInfo: {
          name: companyName,
          description,
          logo,
          website: normalizedUrl,
        },
      };
    } catch (error: any) {
      this.logger.error(`Scrape error: ${error.message}`);
      return this.extractFallbackInfo(normalizedUrl);
    }
  }

  private extractFallbackInfo(url: string): any {
    const normalizedUrl = this.normalizeUrl(url);
    const hostname = new URL(normalizedUrl).hostname;
    const name = this.extractCompanyNameFromUrl(normalizedUrl);

    return {
      url: normalizedUrl,
      hostname,
      markdown: '',
      html: '',
      metadata: {},
      companyInfo: {
        name,
        description: `${name} - AI-powered solutions`,
        logo: sanitizeLogoUrl(`https://www.google.com/s2/favicons?domain=${hostname}&sz=128`),
        website: normalizedUrl,
      },
      isFallback: true,
    };
  }

  private async findPricingPage(baseUrl: string, _markdown: string): Promise<string | null> {
    if (!this.firecrawl) {
      this.logger.warn('Pricing page search skipped - Firecrawl not configured');
      return null;
    }

    const normalizedUrl = this.normalizeUrl(baseUrl);
    let hostname: string;
    try {
      hostname = new URL(normalizedUrl).hostname;
    } catch {
      return null;
    }
    if (!(await isPublicHostname(hostname))) {
      this.logger.warn(`Pricing page search skipped - ${hostname} is not a public host`);
      return null;
    }

    this.logger.log('Finding pricing page...');
    const pricingPaths = ['/pricing', '/plans', '/pricing-plans', '/price', '/packages'];
    const normalizedBase = normalizedUrl.replace(/\/$/, '');

    for (const path of pricingPaths) {
      const pricingUrl = `${normalizedBase}${path}`;
      try {
        const response = await fetch(pricingUrl, { method: 'HEAD', redirect: 'manual' });
        if (response.ok) {
          this.logger.log(`Found pricing page: ${pricingUrl}`);
          return pricingUrl;
        }
      } catch {
        continue;
      }
    }

    this.logger.warn('No pricing page found');
    return null;
  }

  private async scrapePricingPage(pricingUrl: string): Promise<any> {
    if (!this.firecrawl) {
      this.logger.warn('Pricing scraping skipped - Firecrawl not configured');
      return { url: pricingUrl, markdown: '', html: '', success: false };
    }

    this.logger.log(`Scraping pricing page: ${pricingUrl}`);

    try {
      const response: any = await this.withTimeout(
        this.firecrawl.scrape(pricingUrl, { formats: ['markdown', 'html'] }),
        this.firecrawlTimeout,
        'Pricing page scraping timed out',
      );

      const result = response?.data || response;

      return {
        url: pricingUrl,
        markdown: result?.markdown || '',
        html: result?.html || '',
        success: !!result?.markdown,
      };
    } catch (error: any) {
      this.logger.error(`Pricing scrape error: ${error.message}`);
      return { url: pricingUrl, markdown: '', html: '', success: false };
    }
  }

  private async analyzePricing(params: {
    companyName: string;
    companyDescription: string;
    pricingMarkdown: string;
    websiteMarkdown: string;
  }): Promise<any> {
    if (!this.openai) {
      this.logger.warn('Pricing analysis skipped - OpenAI not configured');
      return this.getDefaultPricingData(params.companyName, params.companyDescription);
    }

    this.logger.log('Analyzing pricing with AI...');

    const systemPrompt = `You are a pricing structure analyst. Extract EXACT pricing from websites into JSON.

RULES:
1. Return ONLY valid JSON
2. Extract EXACTLY what's shown - don't invent tiers
3. If "Contact us" price, set basePrice to 0 and isEnterprise to true
4. Create 3-5 agents from features
5. Create 5-8 signals from usage metrics

IMPORTANT:
- billingCycle: ONLY "monthly" or "yearly"
- signal type: ONLY "usage" or "volume"

REQUIRED JSON:
{
  "pricingTiers": [{
    "name": "tier name",
    "basePrice": 99,
    "billingCycle": "monthly",
    "features": ["feature1"],
    "isEnterprise": false
  }],
  "agents": [{
    "name": "Agent Name",
    "agentCode": "AGENT_CODE",
    "description": "description"
  }],
  "signals": [{
    "name": "Signal Name",
    "shortName": "snake_case",
    "type": "usage"
  }]
}`;

    const userPrompt = `Analyze pricing for: ${params.companyName}
Description: ${params.companyDescription}

PRICING PAGE:
${(params.pricingMarkdown || '').substring(0, 12000)}

WEBSITE (for context):
${(params.websiteMarkdown || '').substring(0, 4000)}

Extract ALL pricing tiers with exact prices, features, and create appropriate agents/signals.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.openaiModel,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      const content = response.choices[0]?.message?.content || '{}';
      const pricingData = this.parseAIJson(content);

      this.logger.log(
        `Extracted ${pricingData.pricingTiers?.length || 0} tiers, ${pricingData.signals?.length || 0} signals`,
      );
      return pricingData;
    } catch (error: any) {
      this.logger.error(`Pricing analysis failed: ${error.message}`);
      return this.getDefaultPricingData(params.companyName, params.companyDescription);
    }
  }

  private async generateCustomers(params: {
    companyName: string;
    companyDescription: string;
    pricingTiers: any[];
    count: number;
  }): Promise<any[]> {
    if (!this.openai) {
      this.logger.warn('Customer generation skipped - OpenAI not configured');
      return [];
    }

    this.logger.log(`Generating ${params.count} realistic customers...`);

    const tierNames = params.pricingTiers.map((t) => t.name);

    try {
      const response = await this.openai.chat.completions.create({
        model: this.openaiModel,
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Generate realistic test customers. Return JSON: { "customers": [...] }
Each customer: name, email, phoneNumber, company, industry
Use dummy emails on the reserved example.com domain only, never a real mail provider.`,
          },
          {
            role: 'user',
            content: `Company: ${params.companyName}
Generate ${params.count} diverse customers for plans: ${tierNames.join(', ')}`,
          },
        ],
      });

      const content = response.choices[0]?.message?.content || '{"customers":[]}';
      const data = this.parseAIJson(content);
      return data.customers || this.getDefaultCustomers(params.count);
    } catch (error: any) {
      this.logger.error(`Customer generation failed: ${error.message}`);
      return this.getDefaultCustomers(params.count);
    }
  }

  private parseAIJson(jsonString: string): any {
    if (!jsonString) throw new Error('Empty AI response');

    try {
      return JSON.parse(jsonString);
    } catch {
      let fixed = jsonString
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .replace(/,\s*([}\]])/g, '$1')
        .trim();

      const jsonStart = fixed.search(/[\[{]/);
      const jsonEnd = Math.max(fixed.lastIndexOf('}'), fixed.lastIndexOf(']'));
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        fixed = fixed.substring(jsonStart, jsonEnd + 1);
      }

      return JSON.parse(fixed);
    }
  }

  private getDefaultPricingData(companyName: string, companyDescription: string): any {
    return {
      pricingTiers: [
        {
          name: 'Starter',
          basePrice: 49,
          billingCycle: 'monthly',
          features: ['100 API requests/mo', 'Basic analytics', 'Email support'],
          isEnterprise: false,
        },
        {
          name: 'Professional',
          basePrice: 149,
          billingCycle: 'monthly',
          features: ['1,000 API requests/mo', 'Advanced analytics', 'Priority support'],
          isEnterprise: false,
        },
      ],
      agents: [
        {
          name: companyName,
          agentCode: companyName.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
          description: companyDescription || `${companyName} AI agent`,
        },
      ],
      signals: [
        {
          name: 'API Requests',
          shortName: 'api_requests',
          type: 'usage',
        },
        { name: 'Users', shortName: 'users', type: 'usage' },
      ],
    };
  }

  private getDefaultCustomers(count: number): any[] {
    const defaults = [
      {
        name: 'TechFlow Solutions',
        email: 'contact@techflow.example.com',
        phoneNumber: '+1 (415) 555-1234',
        company: 'TechFlow Solutions',
        industry: 'Technology',
      },
      {
        name: 'MedCore Healthcare',
        email: 'admin@medcore.example.com',
        phoneNumber: '+1 (617) 555-2345',
        company: 'MedCore Healthcare',
        industry: 'Healthcare',
      },
      {
        name: 'RetailEdge Commerce',
        email: 'billing@retailedge.example.com',
        phoneNumber: '+1 (512) 555-3456',
        company: 'RetailEdge Commerce',
        industry: 'Retail',
      },
    ];

    return defaults.slice(0, count);
  }
}
