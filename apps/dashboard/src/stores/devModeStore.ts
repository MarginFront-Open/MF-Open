import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const DEV_MODE_KEY = 'devModeEnabled'

// Check if environment is local/development (hide dev mode bar in deployed environments)
// Uses NODE_ENV which is 'development' only when running in development mode
const isDevEnvironment = () => {
  return process.env.NODE_ENV === 'development'
}

// Get API URLs based on dev mode
const getApiUrls = (isDevMode: boolean) => {
  if (isDevMode) {
    return {
      api: 'http://localhost:4000/v1',
      sdk: 'http://localhost:4000/v1/sdk',
    }
  }
  const api = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000/v1'
  return {
    api,
    sdk: `${api}/sdk`,
  }
}

interface DevModeState {
  isDevMode: boolean
  isDevEnvironment: boolean
  apiUrls: {
    api: string
    sdk: string
  }

  // Actions
  toggleDevMode: () => void
  setDevMode: (enabled: boolean) => void
  getApiBaseUrl: () => string
  getSdkBaseUrl: () => string
}

export const useDevModeStore = create<DevModeState>()(
  persist(
    (set, get) => {
      const devEnv = isDevEnvironment()
      // Default to false - use NEXT_PUBLIC_API_BASE_URL unless explicitly enabled
      const initialDevMode = false

      return {
        isDevMode: initialDevMode,
        isDevEnvironment: devEnv,
        apiUrls: getApiUrls(initialDevMode),

        toggleDevMode: () => {
          const { isDevMode, isDevEnvironment } = get()

          // Only allow toggling in dev environment
          if (!isDevEnvironment) return

          const newDevMode = !isDevMode
          set({
            isDevMode: newDevMode,
            apiUrls: getApiUrls(newDevMode),
          })
        },

        setDevMode: (enabled: boolean) => {
          const { isDevEnvironment } = get()

          // Only allow setting in dev environment
          if (!isDevEnvironment) return

          set({
            isDevMode: enabled,
            apiUrls: getApiUrls(enabled),
          })
        },

        getApiBaseUrl: () => {
          return get().apiUrls.api
        },

        getSdkBaseUrl: () => {
          return get().apiUrls.sdk
        },
      }
    },
    {
      name: DEV_MODE_KEY,
      partialize: (state) => ({ isDevMode: state.isDevMode }),
    }
  )
)
