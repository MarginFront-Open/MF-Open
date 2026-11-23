const mockLookup = jest.fn();

jest.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

const mockSetViewport = jest.fn();
const mockSetRequestInterception = jest.fn();
const mockSetContent = jest.fn();
const mockEvaluate = jest.fn();
const mockPdf = jest.fn();
const mockPageOn = jest.fn();
const mockNewPage = jest.fn();
const mockBrowserClose = jest.fn();
const mockLaunch = jest.fn();

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: {
    launch: (...args: unknown[]) => mockLaunch(...args),
  },
}));

jest.mock('@sparticuz/chromium', () => ({
  __esModule: true,
  default: {
    args: ['--no-sandbox'],
    defaultViewport: { width: 1440, height: 1600 },
    executablePath: jest.fn().mockResolvedValue('/usr/bin/chromium'),
    headless: true,
  },
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PdfService } from './pdf.service';
import {
  assertPublicResolvedHost,
  isPublicIpAddress,
  isSafePublicHttpsUrl,
} from './pdf-url-safety';

type RequestHandler = (request: {
  url: () => string;
  resourceType: () => string;
  redirectChain?: () => unknown[];
  continue: jest.Mock;
  abort: jest.Mock;
}) => Promise<void>;

function createPdfService() {
  return new PdfService({} as any, { get: () => undefined } as any);
}

function makeSampleInvoice(organization: Record<string, unknown> | null = null) {
  return {
    id: 'inv-sec-1',
    invoiceNumber: 'INV-SEC-001',
    invoiceDate: new Date('2026-01-01T00:00:00Z'),
    dueDate: new Date('2026-01-31T00:00:00Z'),
    billingPeriodStart: new Date('2026-01-01T00:00:00Z'),
    billingPeriodEnd: new Date('2026-01-31T00:00:00Z'),
    subtotal: 100,
    totalAmount: 100,
    taxAmount: 0,
    discountAmount: 0,
    status: 'issued',
    customerId: 'cust-1',
    organization,
    customer: { id: 'cust-1', name: 'Acme Customer' },
    items: [],
    metadata: {},
  };
}

function setupMockPuppeteer() {
  let capturedRequestHandler: RequestHandler | null = null;

  mockSetViewport.mockReset().mockResolvedValue(undefined);
  mockSetRequestInterception.mockReset().mockResolvedValue(undefined);
  mockSetContent.mockReset().mockResolvedValue(undefined);
  mockEvaluate.mockReset().mockResolvedValue(undefined);
  mockPdf.mockReset().mockResolvedValue(Buffer.from('%PDF-1.4'));
  mockBrowserClose.mockReset().mockResolvedValue(undefined);
  mockPageOn.mockReset().mockImplementation((event: string, handler: RequestHandler) => {
    if (event === 'request') {
      capturedRequestHandler = handler;
    }
  });
  mockNewPage.mockReset().mockResolvedValue({
    setViewport: mockSetViewport,
    setRequestInterception: mockSetRequestInterception,
    on: mockPageOn,
    setContent: mockSetContent,
    evaluate: mockEvaluate,
    pdf: mockPdf,
  });
  mockLaunch.mockReset().mockResolvedValue({
    newPage: mockNewPage,
    close: mockBrowserClose,
  });

  return () => {
    if (!capturedRequestHandler) {
      throw new Error('Expected Puppeteer page.on("request") handler to be registered');
    }
    return capturedRequestHandler;
  };
}

function makeMockRequest(url: string, resourceType = 'image', redirectChain: unknown[] = []) {
  return {
    url: () => url,
    resourceType: () => resourceType,
    redirectChain: () => redirectChain,
    continue: jest.fn().mockResolvedValue(undefined),
    abort: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Invoice template CSS hardening', () => {
  const apiNestRoot = path.resolve(__dirname, '..', '..', '..');
  const templatePath = path.join(apiNestRoot, 'src', 'templates', 'invoice.hbs');
  const buildScriptPath = path.join(apiNestRoot, 'scripts', 'build-invoice-css.mjs');

  it('contains zero <script> tags or external CDN/font references and has inlined Tailwind CSS', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).not.toMatch(/<script/i);
    expect(template).not.toContain('cdn.tailwindcss.com');
    expect(template).not.toContain('fonts.googleapis.com');
    expect(template).toContain('/* BEGIN INLINED TAILWIND CSS */');
    expect(template).toContain('/* END INLINED TAILWIND CSS */');
    expect(template).toContain('.bg-slate-50');
    expect(template).toContain('.grid-cols-2');
    expect(template).toContain('.max-w-4xl');
    expect(template).toContain('.section-card');
    expect(template).toContain('@page');
  });

  it('passes build-invoice-css.mjs --check without drift', () => {
    const output = execFileSync('node', [buildScriptPath, '--check'], { encoding: 'utf8' });
    expect(output).toContain('Invoice CSS check passed');
  });

  it('renders clean HTML via PdfService._generateHTML without scripts or malicious CSS', async () => {
    const service = createPdfService();
    const html = await (service as any)._generateHTML(
      makeSampleInvoice(),
      {},
      {
        name: 'Acme Corp',
        logo: 'http://169.254.169.254/latest/meta-data/',
        designjson: { headerColor: '#2B3990; background: url(https://evil.example)' },
      },
      { name: 'Customer A' },
    );

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('169.254.169.254');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('background-color: #2B3990');
  });
});

describe('pdf-url-safety', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    '[fe80::1]',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:0001',
    '0:0:0:0:0:ffff:169.254.169.254',
    '[::ffff:10.0.0.1]',
  ])('isPublicIpAddress rejects %s', (ip) => {
    expect(isPublicIpAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '93.184.216.34', '100.63.255.254', '172.32.0.1', '2606:4700::6810:84e5'])(
    'isPublicIpAddress accepts %s',
    (ip) => {
      expect(isPublicIpAddress(ip)).toBe(true);
    },
  );

  it.each([
    '',
    'not-a-url',
    'http://cdn.example.com/logo.png',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'ftp://cdn.example.com/logo.png',
    'https://user:pass@cdn.example.com/logo.png',
    'https://user@cdn.example.com/logo.png',
    'https://localhost/logo.png',
    'https://localhost./logo.png',
    'https://api.localhost/logo.png',
    'https://printer.local/logo.png',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://service.internal./logo.png',
    'https://127.0.0.1/logo.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/logo.png',
    'https://192.168.1.10/logo.png',
    'https://100.64.0.1/logo.png',
    'https://[::1]/logo.png',
    'https://[fe80::1]/logo.png',
    'https://[::ffff:127.0.0.1]/logo.png',
    'https://[::ffff:7f00:1]/logo.png',
    'https://0:0:0:0:0:ffff:169.254.169.254/logo.png',
    'https://0x7f000001/logo.png',
    'https://2130706433/logo.png',
  ])('isSafePublicHttpsUrl rejects %s', (url) => {
    expect(isSafePublicHttpsUrl(url)).toBe(false);
  });

  it.each([
    'https://cdn.example.com/logo.png',
    'https://www.google.com/s2/favicons?domain=example.com&sz=128',
    'https://8.8.8.8/logo.png',
    'https://[2606:4700::6810:84e5]/logo.png',
  ])('isSafePublicHttpsUrl accepts %s', (url) => {
    expect(isSafePublicHttpsUrl(url)).toBe(true);
  });

  it('assertPublicResolvedHost enforces public DNS resolution and blocks rebinding/mixed records', async () => {
    await expect(assertPublicResolvedHost('localhost')).resolves.toBe(false);
    await expect(assertPublicResolvedHost('metadata.internal.')).resolves.toBe(false);
    await expect(assertPublicResolvedHost('[::1]')).resolves.toBe(false);
    expect(mockLookup).not.toHaveBeenCalled();

    await expect(assertPublicResolvedHost('93.184.216.34')).resolves.toBe(true);

    mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(assertPublicResolvedHost('rebind.example.com')).resolves.toBe(false);

    mockLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(assertPublicResolvedHost('mixed.example.com')).resolves.toBe(false);

    mockLookup.mockResolvedValueOnce([]);
    await expect(assertPublicResolvedHost('empty.example.com')).resolves.toBe(false);

    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertPublicResolvedHost('missing.example.com')).resolves.toBe(false);

    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicResolvedHost('cdn.example.com.')).resolves.toBe(true);
    expect(mockLookup).toHaveBeenLastCalledWith('cdn.example.com', { all: true });
  });
});

describe('PdfService._prepareTemplateData sanitization', () => {
  it('strips unsafe logo URLs and sanitizes invalid headerColor', () => {
    const service = createPdfService();

    const unsafe = (service as any)._prepareTemplateData(
      makeSampleInvoice(),
      {},
      {
        name: 'Test Org',
        logo: 'http://169.254.169.254/secret',
        designjson: { headerColor: '#2B3990; } body { background: url(https://evil.test)' },
      },
      null,
    );
    expect(unsafe.organization.logo).toBe('');
    expect(unsafe.organization.designJson.headerColor).toBe('#2B3990');

    const missingDesign = (service as any)._prepareTemplateData(
      makeSampleInvoice(),
      {},
      {
        name: 'Test Org',
        logo: 'https://cdn.example.com/logo.png',
        designjson: null,
      },
      null,
    );
    expect(missingDesign.organization.logo).toBe('https://cdn.example.com/logo.png');
    expect(missingDesign.organization.designJson.headerColor).toBe('#2B3990');

    const validHex = (service as any)._prepareTemplateData(
      makeSampleInvoice(),
      {},
      {
        name: 'Test Org',
        logo: 'https://cdn.example.com/logo.png',
        designjson: { headerColor: '#1a2b3c' },
      },
      null,
    );
    expect(validHex.organization.designJson.headerColor).toBe('#1a2b3c');
  });
});

describe('PdfService Puppeteer request interception on BOTH PDF paths', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  async function assertRequestInterceptionBehavior(runPdfPath: (logo: string) => Promise<void>) {
    const allowedLogo = 'https://cdn.example.com/logo.png';
    const getHandler = setupMockPuppeteer();

    await runPdfPath(allowedLogo);

    expect(mockSetRequestInterception).toHaveBeenCalledWith(true);
    const handler = getHandler();

    // 1. about:blank allowed
    const blankReq = makeMockRequest('about:blank', 'document');
    await handler(blankReq);
    expect(blankReq.continue).toHaveBeenCalledTimes(1);
    expect(blankReq.abort).not.toHaveBeenCalled();

    // 2. Valid public HTTPS logo image allowed
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const logoReq = makeMockRequest(allowedLogo, 'image');
    await handler(logoReq);
    expect(logoReq.continue).toHaveBeenCalledTimes(1);
    expect(logoReq.abort).not.toHaveBeenCalled();

    // 3. Disallowed resource types aborted even for allowedLogo URL
    for (const badType of ['script', 'stylesheet', 'xhr', 'fetch', 'font', 'document']) {
      const badTypeReq = makeMockRequest(allowedLogo, badType);
      await handler(badTypeReq);
      expect(badTypeReq.abort).toHaveBeenCalledWith('blockedbyclient');
      expect(badTypeReq.continue).not.toHaveBeenCalled();
    }

    // 4. Disallowed URLs aborted
    for (const badUrl of [
      'https://other.example.com/pixel.png',
      'http://cdn.example.com/logo.png',
      'file:///etc/passwd',
      'data:image/svg+xml,<svg/>',
      'http://169.254.169.254/latest/meta-data/',
      'https://169.254.169.254/latest/meta-data/',
    ]) {
      const badUrlReq = makeMockRequest(badUrl, 'image');
      await handler(badUrlReq);
      expect(badUrlReq.abort).toHaveBeenCalledWith('blockedbyclient');
      expect(badUrlReq.continue).not.toHaveBeenCalled();
    }

    // 5. Redirects aborted even if landing on allowedLogo URL
    const redirectReq = makeMockRequest(allowedLogo, 'image', [
      { url: 'https://redirect.example' },
    ]);
    await handler(redirectReq);
    expect(redirectReq.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(redirectReq.continue).not.toHaveBeenCalled();

    // 6. DNS rebinding to private/metadata IP aborted
    mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const rebindReq = makeMockRequest(allowedLogo, 'image');
    await handler(rebindReq);
    expect(rebindReq.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(rebindReq.continue).not.toHaveBeenCalled();
  }

  it('enforces request interception in _generatePDF (via generateInvoicePDF)', async () => {
    const service = createPdfService();
    await assertRequestInterceptionBehavior(async (logo) => {
      const result = await service.generateInvoicePDF(makeSampleInvoice({ name: 'Acme', logo }));
      expect(result.s3Location).toContain('INV-SEC-001');
    });
  });

  it('enforces request interception when _generatePDF is invoked directly', async () => {
    const service = createPdfService();
    const getHandler = setupMockPuppeteer();

    await (service as any)._generatePDF('<html></html>', '/tmp/test-direct.pdf');
    expect(mockSetRequestInterception).toHaveBeenCalledWith(true);

    const handler = getHandler();
    const externalImg = makeMockRequest('https://cdn.example.com/logo.png', 'image');
    await handler(externalImg);
    expect(externalImg.abort).toHaveBeenCalledWith('blockedbyclient');
  });

  it('enforces request interception in generateInvoicePDFBuffer', async () => {
    const service = createPdfService();
    await assertRequestInterceptionBehavior(async (logo) => {
      const buf = await service.generateInvoicePDFBuffer(makeSampleInvoice({ name: 'Acme', logo }));
      expect(Buffer.isBuffer(buf)).toBe(true);
    });
  });

  it('blocks image requests in generateInvoicePDFBuffer when organization logo is unsafe', async () => {
    const service = createPdfService();
    const getHandler = setupMockPuppeteer();

    await service.generateInvoicePDFBuffer(
      makeSampleInvoice({ name: 'Acme', logo: 'http://169.254.169.254/latest/meta-data/' }),
    );
    expect(mockSetRequestInterception).toHaveBeenCalledWith(true);

    const handler = getHandler();
    const req = makeMockRequest('http://169.254.169.254/latest/meta-data/', 'image');
    await handler(req);
    expect(req.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(req.continue).not.toHaveBeenCalled();
  });
});
