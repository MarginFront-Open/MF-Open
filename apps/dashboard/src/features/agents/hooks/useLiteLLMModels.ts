import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  LiteLLMModel,
  LiteLLMRawModel,
  transformRawModel,
  PROVIDER_DISPLAY_NAMES,
  getModesForServiceName,
} from '../data/litellm-models'

interface UseLiteLLMModelsReturn {
  models: LiteLLMModel[]
  providers: string[]
  isLoading: boolean
  error: Error | null
  getModelsByProvider: (provider: string) => LiteLLMModel[]
  getModelsByServiceName: (serviceName: string) => LiteLLMModel[]
  searchModels: (query: string, provider?: string) => LiteLLMModel[]
  searchModelsByServiceName: (
    query: string,
    serviceName: string
  ) => LiteLLMModel[]
}

/**
 * Hook to load and manage LiteLLM model pricing data
 * Fetches from /data/litellm-model-prices.json and transforms for use
 */
export function useLiteLLMModels(): UseLiteLLMModelsReturn {
  const [rawData, setRawData] = useState<Record<
    string,
    LiteLLMRawModel
  > | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  // Fetch the JSON data on mount
  useEffect(() => {
    let cancelled = false

    async function fetchData() {
      try {
        const response = await fetch('/data/litellm-model-prices.json')
        if (!response.ok) {
          throw new Error(
            `Failed to fetch model prices: ${response.statusText}`
          )
        }
        const data = await response.json()
        if (!cancelled) {
          setRawData(data)
          setIsLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error('Unknown error'))
          setIsLoading(false)
        }
      }
    }

    fetchData()

    return () => {
      cancelled = true
    }
  }, [])

  // Transform raw data into normalized models
  const models = useMemo(() => {
    if (!rawData) return []

    return (
      Object.entries(rawData)
        .filter(([key]) => key !== 'sample_spec') // Skip the spec entry
        .map(([key, value]) => transformRawModel(key, value))
        // No mode filter, so every service type is listed.
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    )
  }, [rawData])

  // Get list of providers that have models
  const providers = useMemo(() => {
    const providersWithModels = new Set(models.map((m) => m.provider))
    return PROVIDER_DISPLAY_NAMES.filter((p) => providersWithModels.has(p))
  }, [models])

  // Get models filtered by provider
  const getModelsByProvider = useCallback(
    (provider: string): LiteLLMModel[] => {
      if (!provider || provider === 'Custom') return []
      return models.filter((m) => m.provider === provider)
    },
    [models]
  )

  // Get models filtered by service name (maps to LiteLLM modes)
  const getModelsByServiceName = useCallback(
    (serviceName: string): LiteLLMModel[] => {
      if (!serviceName || serviceName === 'Custom') return []
      const modes = getModesForServiceName(serviceName)
      if (modes.length === 0) return []
      return models.filter((m) => modes.includes(m.mode))
    },
    [models]
  )

  // Search models by query string, optionally filtered by provider
  const searchModels = useCallback(
    (query: string, provider?: string): LiteLLMModel[] => {
      const lowerQuery = query.toLowerCase().trim()

      let filtered = models

      // Filter by provider if specified
      if (provider && provider !== 'Custom') {
        filtered = filtered.filter((m) => m.provider === provider)
      }

      // Filter by search query
      if (lowerQuery) {
        filtered = filtered.filter(
          (m) =>
            m.displayName.toLowerCase().includes(lowerQuery) ||
            m.id.toLowerCase().includes(lowerQuery)
        )
      }

      // Limit results for performance
      return filtered.slice(0, 100)
    },
    [models]
  )

  // Search models by query string, filtered by service name
  const searchModelsByServiceName = useCallback(
    (query: string, serviceName: string): LiteLLMModel[] => {
      const lowerQuery = query.toLowerCase().trim()
      const modes = getModesForServiceName(serviceName)

      let filtered = models

      // Filter by service name (mode)
      if (modes.length > 0) {
        filtered = filtered.filter((m) => modes.includes(m.mode))
      }

      // Filter by search query
      if (lowerQuery) {
        filtered = filtered.filter(
          (m) =>
            m.displayName.toLowerCase().includes(lowerQuery) ||
            m.id.toLowerCase().includes(lowerQuery)
        )
      }

      // Limit results for performance
      return filtered.slice(0, 100)
    },
    [models]
  )

  return {
    models,
    providers,
    isLoading,
    error,
    getModelsByProvider,
    getModelsByServiceName,
    searchModels,
    searchModelsByServiceName,
  }
}
