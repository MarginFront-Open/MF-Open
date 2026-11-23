'use client'

import { useQuery } from '@tanstack/react-query'
import { getOrgBillingIdentity } from '@/app/actions/org-billing-identity'
import {
  sellerFromIdentity,
  type InvoiceSeller,
} from './billing-identity-display'

/**
 * The org's stored billing identity, shaped for the invoice FROM block.
 * Returns undefined until loaded (the print view then renders no FROM block
 * rather than inventing one).
 */
export function useSellerIdentity(): InvoiceSeller | undefined {
  const { data } = useQuery({
    queryKey: ['org-billing-identity', 'seller'],
    queryFn: () => getOrgBillingIdentity(),
  })
  if (!data?.success) return undefined
  return sellerFromIdentity(data.data.orgName, data.data.identity)
}
