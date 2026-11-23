import { PublicInvoiceService } from './public-invoice.service';

function serviceFor(row: { id: string; invoiceNumber: string; pdfUrl: string | null }) {
  const prisma = { invoices: { findUnique: jest.fn(async () => row) } };
  return new PublicInvoiceService(prisma as any, {} as any);
}

describe('PublicInvoiceService.getPublicInvoicePdf', () => {
  it('returns the stored PDF address when there is one', async () => {
    const service = serviceFor({
      id: 'inv-1',
      invoiceNumber: 'INV-1',
      pdfUrl: 'https://files.example.com/inv-1.pdf',
    });

    await expect(service.getPublicInvoicePdf('inv-1')).resolves.toEqual({
      url: 'https://files.example.com/inv-1.pdf',
      invoiceNumber: 'INV-1',
    });
  });

  it('returns no address, rather than a made-up one on another host, when no PDF is stored', async () => {
    const service = serviceFor({ id: 'inv-2', invoiceNumber: 'INV-2', pdfUrl: null });

    const result = await service.getPublicInvoicePdf('inv-2');

    expect(result.url).toBeNull();
    expect(result.message).toMatch(/No PDF has been stored for this invoice yet/);
  });
});

describe('PublicInvoiceService.createCheckoutSession', () => {
  it('lets the server pick where the payer lands after checkout, never the caller', async () => {
    const prisma = {
      invoices: {
        findUnique: jest.fn(async () => ({
          id: 'inv-3',
          invoiceNumber: 'INV-3',
          status: 'open',
          totalAmount: 100,
          currency: 'USD',
        })),
      },
    };
    const createCheckoutSession = jest.fn(async () => ({
      sessionId: 'cs_1',
      url: 'https://checkout.example.com/cs_1',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    const service = new PublicInvoiceService(prisma as any, { createCheckoutSession } as any);

    await (service.createCheckoutSession as (...args: unknown[]) => Promise<unknown>)('inv-3', {
      successUrl: 'https://elsewhere.example.com/after',
      cancelUrl: 'https://elsewhere.example.com/cancel',
    });

    expect(createCheckoutSession).toHaveBeenCalledWith('inv-3');
  });
});
