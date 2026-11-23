'use client'

/**
 * Hook for live service pricing data
 *
 * Fetches the service pricing catalog from /api/service-pricing.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { ServicePricingEntry } from '@/app/actions/service-pricing'

interface UseServicePricingReturn {
  entries: ServicePricingEntry[]
  models: ServicePricingEntry[]
  apis: ServicePricingEntry[]
  serviceTypes: string[]
  isLoading: boolean
  error: Error | null
  lastUpdated: string | null
  getByServiceType: (serviceType: string) => ServicePricingEntry[]
  search: (query: string, serviceType?: string) => ServicePricingEntry[]
}

export function useServicePricing(): UseServicePricingReturn {
  const [models, setModels] = useState<ServicePricingEntry[]>([])
  const [apis, setApis] = useState<ServicePricingEntry[]>([])
  const [serviceTypes, setServiceTypes] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await fetch('/api/service-pricing')
        if (!response.ok) {
          throw new Error(`Failed to load pricing: ${response.status}`)
        }
        const data = await response.json()

        if (!cancelled) {
          setModels(data.models || [])
          setApis(data.apis || [])
          setServiceTypes(data.serviceTypes || ['Custom'])
          setLastUpdated(data.lastUpdated || null)
          setIsLoading(false)
          console.log(
            `[use-service-pricing] Loaded ${data.models?.length || 0} models, ${data.apis?.length || 0} APIs`
          )
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[use-service-pricing] Error:', err)
          setError(
            err instanceof Error ? err : new Error('Failed to load pricing')
          )
          setIsLoading(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  const entries = useMemo(() => [...models, ...apis], [models, apis])

  const getByServiceType = useCallback(
    (serviceType: string): ServicePricingEntry[] => {
      if (!serviceType || serviceType === 'Custom') return []
      return entries.filter((e) => e.serviceType === serviceType)
    },
    [entries]
  )

  const search = useCallback(
    (query: string, serviceType?: string): ServicePricingEntry[] => {
      const lowerQuery = query.toLowerCase().trim()
      let filtered = entries

      if (serviceType && serviceType !== 'Custom') {
        filtered = filtered.filter((e) => e.serviceType === serviceType)
      }

      if (lowerQuery) {
        filtered = filtered.filter(
          (e) =>
            e.displayName.toLowerCase().includes(lowerQuery) ||
            e.id.toLowerCase().includes(lowerQuery) ||
            e.provider.toLowerCase().includes(lowerQuery)
        )
      }

      return filtered.slice(0, 100)
    },
    [entries]
  )

  return {
    entries,
    models,
    apis,
    serviceTypes,
    isLoading,
    error,
    lastUpdated,
    getByServiceType,
    search,
  }
}
