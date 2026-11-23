import { resolveOrgBillingContactEmail } from './billing-contact.utils';

describe('resolveOrgBillingContactEmail', () => {
  it('billing_email wins over billingIdentity.email', () => {
    expect(
      resolveOrgBillingContactEmail({
        billing_email: 'api-set@acme.test',
        billingIdentity: { email: 'identity@acme.test' },
      }),
    ).toBe('api-set@acme.test');
  });

  it('falls back to billingIdentity.email when billing_email is null', () => {
    expect(
      resolveOrgBillingContactEmail({
        billing_email: null,
        billingIdentity: { email: 'identity@acme.test' },
      }),
    ).toBe('identity@acme.test');
  });

  it('trims whitespace around a valid billingIdentity.email', () => {
    expect(
      resolveOrgBillingContactEmail({
        billing_email: null,
        billingIdentity: { email: '  identity@acme.test  ' },
      }),
    ).toBe('identity@acme.test');
  });

  it('blank billing_email does not win — falls through to billingIdentity', () => {
    expect(
      resolveOrgBillingContactEmail({
        billing_email: '   ',
        billingIdentity: { email: 'identity@acme.test' },
      }),
    ).toBe('identity@acme.test');
  });

  it.each([
    ['null org', null],
    ['undefined org', undefined],
  ])('%s resolves to null', (_label, org) => {
    expect(resolveOrgBillingContactEmail(org as any)).toBeNull();
  });

  it.each([
    ['null billingIdentity', null],
    ['string billingIdentity', 'not-an-object'],
    ['number billingIdentity', 42],
    ['array billingIdentity', ['identity@acme.test']],
    ['missing email key', { legalName: 'Acme Legal Co' }],
    ['non-string email', { email: 42 }],
    ['blank email', { email: '' }],
    ['whitespace email', { email: '   ' }],
    ['not email-shaped', { email: 'not-an-email' }],
    ['email with spaces', { email: 'a b@acme.test' }],
  ])('malformed billingIdentity (%s) resolves to null without throwing', (_label, identity) => {
    expect(
      resolveOrgBillingContactEmail({ billing_email: null, billingIdentity: identity }),
    ).toBeNull();
  });
});
