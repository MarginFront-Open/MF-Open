import { API_ENDPOINTS } from '@/lib/api/config'
import apiClient from './client'

// User API functions
export const userApi = {
  getProfile: async () => {
    return apiClient.get(API_ENDPOINTS.USER.PROFILE)
  },

  updateProfile: async (profileData: any) => {
    return apiClient.patch(API_ENDPOINTS.USER.UPDATE_PROFILE, profileData)
  },
}
