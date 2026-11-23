/**
 * API Request Builder
 * @deprecated Use Server Actions instead.
 * All new features should use Server Actions with Better Auth session-based authentication.
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { authClient } from '@/app/lib/auth-client'
import { clearTokenCache } from '@/lib/api/client'
import { API_BASE_URL, API_TIMEOUT } from '@/lib/api/config'

export { API_BASE_URL, API_TIMEOUT }

// Create axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  withCredentials: true,
})

// Request interceptor - cookies are automatically sent with withCredentials: true
apiClient.interceptors.request.use(
  async (config) => {
    // This client relies on cookie-based session authentication.
    // For external API calls that require JWT, use Server Actions instead.
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor for handling auth errors
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    // If 401 error, clear cache and sign out
    if (error.response?.status === 401) {
      clearTokenCache()

      try {
        await authClient.signOut()
      } catch {
        // Ignore sign out errors
      }

      window.location.href = '/sign-in'
    }

    return Promise.reject(error)
  }
)

// Helper for URL parameters
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

// Request methods
export const request = {
  get: <T>(url: string, config?: AxiosRequestConfig): Promise<T> => {
    return apiClient.get(url, config).then((res: AxiosResponse) => res.data)
  },

  post: <T>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<T> => {
    return apiClient
      .post(url, data, config)
      .then((res: AxiosResponse) => res.data)
  },

  put: <T>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<T> => {
    return apiClient
      .put(url, data, config)
      .then((res: AxiosResponse) => res.data)
  },

  patch: <T>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<T> => {
    return apiClient
      .patch(url, data, config)
      .then((res: AxiosResponse) => res.data)
  },

  delete: <T>(url: string, config?: AxiosRequestConfig): Promise<T> => {
    return apiClient.delete(url, config).then((res: AxiosResponse) => res.data)
  },
}

export default request
