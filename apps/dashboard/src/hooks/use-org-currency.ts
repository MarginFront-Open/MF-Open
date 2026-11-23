import { useMemo } from 'react'
import { storage } from '@/lib/storage'
import { useAuth } from '@/hooks/use-auth'

const ORG_CURRENCY_KEY = 'org_currency'
const DEFAULT_CURRENCY = 'USD'

/**
 * Returns the currency symbol for a given ISO currency code.
 */
function getCurrencySymbol(currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
      .format(0)
      .replace(/\d/g, '')
      .trim()
  } catch {
    return '$'
  }
}

/**
 * Hook to retrieve and cache the organization's currency.
 * - Prefers the org's currency from the auth store
 * - Falls back to localStorage
 * - Defaults to USD
 */
export function useOrgCurrency(): {
  orgCurrency: string
  currencySymbol: string
} {
  const { getOrg } = useAuth()

  return useMemo(() => {
    const org = getOrg()
    const currency =
      org?.currency || storage.getItem(ORG_CURRENCY_KEY) || DEFAULT_CURRENCY

    if (org?.currency) {
      storage.setItem(ORG_CURRENCY_KEY, currency)
    }

    return {
      orgCurrency: currency,
      currencySymbol: getCurrencySymbol(currency),
    }
  }, [getOrg])
}
