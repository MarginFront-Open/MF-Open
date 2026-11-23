/**
 * @deprecated This client is deprecated. Use Server Actions instead.
 * All new features should use Server Actions with Better Auth session-based authentication.
 */
import axios, {
  AxiosError,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios'
import { authClient } from '@/app/lib/auth-client'
import { API_BASE_URL, API_TIMEOUT } from '@/lib/api/config'

// Create axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  withCredentials: true, // Include cookies for session management
})

// Request interceptor - cookies are automatically sent with withCredentials: true
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    // This client relies on cookie-based session authentication.
    // For external API calls that require JWT, use Server Actions instead.
    return config
  },
  (error: AxiosError) => {
    return Promise.reject(error)
  }
)

// Response interceptor for handling auth errors
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError) => {
    // If 401 error, sign out and redirect to sign-in
    if (error.response?.status === 401) {
      try {
        await authClient.signOut()
      } catch (signOutError) {
        console.error('[API Client] Error signing out:', signOutError)
      }

      window.location.href = '/sign-in'
    }

    return Promise.reject(error)
  }
)

// Helper function to get organization ID from Better Auth session
export const getOrgId = async (): Promise<string | null> => {
  try {
    const session = await authClient.getSession()
    return session.data?.session?.activeOrganizationId || null
  } catch {
    return null
  }
}

// Sync version (uses cached value)
let cachedOrgId: string | null = null
export const getOrgIdSync = (): string | null => {
  // Update cache in background
  getOrgId().then((id) => {
    cachedOrgId = id
  })
  return cachedOrgId
}

// Helper function to format URLs with parameters
export const formatUrl = (
  url: string,
  params: Record<string, string | null>
) => {
  let formattedUrl = url
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null) {
      formattedUrl = formattedUrl.replace(`:${key}`, value)
    }
  })
  return formattedUrl
}

// Clear cache (useful for logout)
export const clearTokenCache = () => {
  cachedOrgId = null
}

export default apiClient
