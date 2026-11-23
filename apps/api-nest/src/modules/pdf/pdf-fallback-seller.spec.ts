import { PdfService } from './pdf.service';

function templateDataWithoutOrganization(config: Record<string, string | undefined>) {
  const service = new PdfService({} as any, { get: (key: string) => config[key] } as any);
  const invoice = {
    id: 'inv-1',
    invoiceNumber: 'INV-1',
    currency: 'USD',
    totalAmount: 0,
    subtotal: 0,
    lineItems: [],
    metadata: {},
  };
  return (service as any)._prepareTemplateData(invoice, {}, null, null);
}

describe('PdfService seller block when the invoice has no organization row', () => {
  it('prints a neutral name and no invented address, email or phone', () => {
    const { organization } = templateDataWithoutOrganization({});

    expect(organization.name).toBe('Usage Billing');
    expect(organization.billingEmail).toBe('');
    expect(organization.billingPhone).toBe('');
    expect(organization.addressLine1).toBe('');
    expect(JSON.stringify(organization)).not.toMatch(/marginfront|Main Street|555/i);
  });

  it('uses PRODUCT_NAME for the seller name when set', () => {
    const { organization } = templateDataWithoutOrganization({ PRODUCT_NAME: 'Larkspur Billing' });

    expect(organization.name).toBe('Larkspur Billing');
  });
});
