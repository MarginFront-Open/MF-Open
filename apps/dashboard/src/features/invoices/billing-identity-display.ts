/**
 * Invoice FROM-block mapping: only fields the org actually stored survive;
 * the one allowed fallback is the org display name. Nothing is invented.
 */

export interface OrgBillingIdentity {
  legalName?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  email?: string
}

export interface InvoiceSeller {
  name: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  email?: string
}

function presence(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function sellerFromIdentity(
  orgDisplayName: string,
  identity: OrgBillingIdentity | null | undefined
): InvoiceSeller {
  const name = presence(identity?.legalName) ?? orgDisplayName
  if (!identity) {
    return { name }
  }
  return {
    name,
    addressLine1: presence(identity.addressLine1),
    addressLine2: presence(identity.addressLine2),
    city: presence(identity.city),
    state: presence(identity.state),
    postalCode: presence(identity.postalCode),
    country: presence(identity.country),
    email: presence(identity.email),
  }
}
