jest.mock('@mendable/firecrawl-js', () => jest.fn().mockImplementation(() => ({})));

import { OnboardingService } from './onboarding.service';

function makeService(firecrawlKey: string): OnboardingService {
  const config = {
    get: (key: string) => (key === 'FIRECRAWL_API_KEY' ? firecrawlKey : undefined),
  } as any;
  return new OnboardingService({} as any, config);
}

function findPricingPage(service: OnboardingService, url: string): Promise<string | null> {
  return (service as any).findPricingPage(url, '');
}

describe('OnboardingService pricing page search', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends no request when Firecrawl is not configured', async () => {
    await expect(findPricingPage(makeService(''), 'https://example.com')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['http://127.0.0.1', 'http://10.0.0.8:8080', 'localhost:3000', 'http://[::1]'])(
    'sends no request to the private host %s',
    async (url) => {
      await expect(findPricingPage(makeService('fc-test'), url)).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
