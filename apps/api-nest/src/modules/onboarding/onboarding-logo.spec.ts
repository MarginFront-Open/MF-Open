import { OnboardingService } from './onboarding.service';

describe('OnboardingService logo URL sanitization', () => {
  function createService(orgUpdate = jest.fn().mockResolvedValue({ id: 'org-1' })) {
    const tx = {
      organizations: { update: orgUpdate },
      agents: { create: jest.fn() },
      signals: { create: jest.fn() },
      pricing_plans: { create: jest.fn() },
      agent_pricing_plans: { create: jest.fn() },
      pricing_strategies: { create: jest.fn() },
      customers: { create: jest.fn() },
      subscriptions: { create: jest.fn() },
    };
    const prisma = {
      organizations: {
        findUnique: jest.fn().mockResolvedValue({ id: 'org-1' }),
        update: orgUpdate,
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const config = { get: jest.fn().mockReturnValue('') };
    return {
      service: new OnboardingService(prisma as any, config as any),
      orgUpdate,
    };
  }

  it('drops unsafe companyInfo.logo to null in createFromPreview', async () => {
    const { service, orgUpdate } = createService();

    await service.createFromPreview({
      organizationId: 'org-1',
      previewData: {
        companyInfo: {
          name: 'Acme',
          website: 'https://acme.example.com',
          logo: 'http://169.254.169.254/latest/meta-data/',
        },
        agents: [],
        pricingData: { signals: [], tiers: [] },
        customers: [],
      },
    });

    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          logo: null,
        }),
      }),
    );
  });

  it('persists valid public HTTPS companyInfo.logo in createFromPreview', async () => {
    const { service, orgUpdate } = createService();
    const safeLogo = 'https://cdn.example.com/logo.png';

    await service.createFromPreview({
      organizationId: 'org-1',
      previewData: {
        companyInfo: {
          name: 'Acme',
          website: 'https://acme.example.com',
          logo: safeLogo,
        },
        agents: [],
        pricingData: { signals: [], tiers: [] },
        customers: [],
      },
    });

    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          logo: safeLogo,
        }),
      }),
    );
  });

  it('drops unsafe logo in onboardFromWebsite when skipBilling is true', async () => {
    const { service, orgUpdate } = createService();
    jest.spyOn(service, 'enhancedPreview').mockResolvedValue({
      success: true,
      websiteUrl: 'https://acme.example.com',
      pricingPageUrl: null,
      companyInfo: {
        name: 'Acme',
        description: 'Acme',
        logo: 'https://127.0.0.1/logo.png',
        website: 'https://acme.example.com',
        screenshotUrl: null,
      },
      pricingData: { tiers: [], signals: [], serviceCosts: [] },
      customers: [],
      agents: [],
      summary: {
        pricingTiersCount: 0,
        signalsCount: 0,
        serviceCostsCount: 0,
        customersCount: 0,
      },
      message: 'ok',
    });

    await service.onboardFromWebsite({
      organizationId: 'org-1',
      websiteUrl: 'https://acme.example.com',
      skipBilling: true,
    });

    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          logo: null,
        }),
      }),
    );
  });
});
