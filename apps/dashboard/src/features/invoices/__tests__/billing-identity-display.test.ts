/**
 * Behavior of the FROM-block mapping: only stored
 * fields survive, and the one fallback we allow is the org display name
 * (which every org truly has). Nothing is ever invented.
 */

import { sellerFromIdentity } from '../billing-identity-display'

describe('sellerFromIdentity — org-name fallback', () => {
  it('nothing stored: the seller is the org display name and NOTHING else', () => {
    const seller = sellerFromIdentity('Acme Corp', null)
    expect(seller.name).toBe('Acme Corp')
    expect(
      Object.values({ ...seller, name: undefined }).every(
        (value) => value === undefined
      )
    ).toBe(true)
  })

  it('identity without a legal name still falls back to the org display name', () => {
    const seller = sellerFromIdentity('Acme Corp', { city: 'Springfield' })
    expect(seller.name).toBe('Acme Corp')
    expect(seller.city).toBe('Springfield')
  })

  it('a whitespace-only legal name does not beat the org display name', () => {
    expect(sellerFromIdentity('Acme Corp', { legalName: '   ' }).name).toBe(
      'Acme Corp'
    )
  })
})

describe('sellerFromIdentity — stored fields pass through, nothing invented', () => {
  it('a stored legal name wins over the display name', () => {
    expect(
      sellerFromIdentity('Acme Corp', { legalName: 'Acme Holdings Ltd' }).name
    ).toBe('Acme Holdings Ltd')
  })

  it('every stored field maps through trimmed; missing fields stay undefined', () => {
    const seller = sellerFromIdentity('Acme Corp', {
      legalName: ' Acme Holdings Ltd ',
      addressLine1: '100 Example Ave',
      city: 'Springfield',
      state: 'ZZ',
      postalCode: '00000',
      email: 'billing@acme.example',
    })
    expect(seller).toEqual({
      name: 'Acme Holdings Ltd',
      addressLine1: '100 Example Ave',
      addressLine2: undefined,
      city: 'Springfield',
      state: 'ZZ',
      postalCode: '00000',
      country: undefined,
      email: 'billing@acme.example',
    })
  })
})
