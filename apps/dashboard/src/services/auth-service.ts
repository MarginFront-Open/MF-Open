// @ts-nocheck

/**
 * Auth Service
 * Service layer for handling authentication-related API operations with React Query hooks
 * NOTE: These hooks are deprecated for new code. Use Better Auth hooks from @/hooks/use-auth instead.
 */
import { useMutation } from '@tanstack/react-query'
import { authClient } from '@/app/lib/auth-client'
import { clearTokenCache } from '@/lib/api/client'
import { storage } from '@/lib/storage'
import { useToast } from '@/hooks/use-toast'
import request from './api-request'

// Endpoints specific to auth
const AUTH_ENDPOINTS = {
  LOGIN: '/auth/login',
  REGISTER: '/auth/register',
  FORGOT_PASSWORD: '/auth/forgot-password',
  SEND_RESET_PASSWORD_OTP: '/auth/send-reset-password-otp',
  RESET_PASSWORD: '/auth/reset-password',
  VERIFY_OTP: '/auth/verify-email',
  RESEND_VERIFICATION_EMAIL: '/auth/send-verification-email',
  LOGOUT: '/auth/logout',
  REFRESH_TOKEN: '/auth/refresh-tokens',
}

// Types
export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  name: string
  email: string
  password: string
}

export interface ResetPasswordRequest {
  email: string
  otp: string
  password: string
}

export interface User {
  id: string
  name: string
  email: string
  role: string
  organizationId?: string
  isEmailVerified?: boolean
  status?: string
}

export interface Organization {
  id: string
  name: string
  organizationInfo: string
  website: string
  linkedin: string
  logo: string
  currency: string
  timezone: string
  onboardingComplete: boolean
  onboardingStep: string | null
  createdAt: string
  updatedAt: string
}

export interface TokenPair {
  access: {
    token: string
    expires: string
  }
  refresh: {
    token: string
    expires: string
  }
}

export interface LoginResponse {
  tokens: TokenPair
  user: User
  org?: Organization
}

export interface RegisterResponse {
  user: User
  message: string
}

export interface VerifyOtpResponse {
  tokens?: TokenPair
  message: string
}

export interface ResetPasswordResponse {
  message: string
}

export interface LogoutResponse {
  message: string
}

// Auth service with direct API methods
export const authService = {
  /**
   * Login with email and password
   * @param data LoginRequest containing email and password
   * @returns LoginResponse with tokens and user data
   */
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    return request.post<LoginResponse>(AUTH_ENDPOINTS.LOGIN, data)
  },

  /**
   * Register a new user
   * @param data RegisterRequest containing user registration data
   * @returns RegisterResponse with created user and message
   */
  register: async (data: RegisterRequest): Promise<RegisterResponse> => {
    return request.post<RegisterResponse>(AUTH_ENDPOINTS.REGISTER, data)
  },

  /**
   * Send forgot password email
   * @param email User's email address
   * @returns Response with message
   */
  forgotPassword: async (email: string) => {
    return request.post(AUTH_ENDPOINTS.FORGOT_PASSWORD, { email })
  },

  /**
   * Send reset password OTP
   * @param email User's email address
   * @returns Response with message
   */
  sendResetPasswordOTP: async (email: string) => {
    return request.post(AUTH_ENDPOINTS.SEND_RESET_PASSWORD_OTP, { email })
  },

  /**
   * Reset password with OTP
   * @param data ResetPasswordRequest containing email, OTP, and new password
   * @returns ResetPasswordResponse with message
   */
  resetPassword: async (
    data: ResetPasswordRequest
  ): Promise<ResetPasswordResponse> => {
    return request.post<ResetPasswordResponse>(
      AUTH_ENDPOINTS.RESET_PASSWORD,
      data
    )
  },

  /**
   * Verify email with OTP
   * @param email User's email address
   * @param otp One-time password sent to email
   * @returns VerifyOtpResponse with tokens or message
   */
  verifyOtp: async (email: string, otp: string): Promise<VerifyOtpResponse> => {
    return request.post<VerifyOtpResponse>(AUTH_ENDPOINTS.VERIFY_OTP, {
      email,
      otp,
    })
  },

  /**
   * Logout user
   * @param refreshToken User's refresh token
   * @returns LogoutResponse with message
   */
  logout: async (refreshToken: string): Promise<LogoutResponse> => {
    return request.post<LogoutResponse>(AUTH_ENDPOINTS.LOGOUT, { refreshToken })
  },

  /**
   * Refresh access token
   * @param refreshToken User's refresh token
   * @returns Object containing new token pair
   */
  refreshToken: async (refreshToken: string) => {
    return request.post(AUTH_ENDPOINTS.REFRESH_TOKEN, { refreshToken })
  },

  /**
   * Resend verification email
   * @param email User's email address
   * @returns Response with message
   */
  resendVerificationEmail: async (email: string) => {
    return request.post(AUTH_ENDPOINTS.RESEND_VERIFICATION_EMAIL, { email })
  },
}

// React Query Hooks

/**
 * Hook for user login
 * @deprecated Use authClient.signIn.email from @/app/lib/auth-client instead
 */
export function useLogin() {
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (credentials: LoginRequest) => {
      // Use Better Auth for login
      const result = await authClient.signIn.email({
        email: credentials.email,
        password: credentials.password,
      })
      if (result.error) {
        throw new Error(result.error.message || 'Login failed')
      }
      return result.data
    },

    onSuccess: () => {
      toast({
        title: 'Success',
        description: 'Logged in successfully',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Login failed',
        description: error.message || 'Invalid credentials',
      })
    },
  })
}

/**
 * Hook for user registration
 * Uses React Query's useMutation for state management
 */
export function useRegister() {
  const { toast } = useToast()

  return useMutation({
    mutationFn: (userData: RegisterRequest) => authService.register(userData),

    onSuccess: (data) => {
      toast({
        title: 'Success',
        description:
          data.message ||
          'Registration successful. Please check your email for verification.',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Registration failed',
        description: error.response?.data?.message || 'Could not register',
      })
    },
  })
}

/**
 * Hook for forgot password functionality
 * Uses React Query's useMutation for state management
 */
export function useForgotPassword() {
  const { toast } = useToast()

  return useMutation({
    mutationFn: (email: string) => authService.sendResetPasswordOTP(email),

    onSuccess: (data: any) => {
      // Store email in localStorage for reset password step
      if (data && data.email) {
        storage.setItem('resetPasswordEmail', data.email)
      }

      toast({
        title: 'Success',
        description:
          data?.message || 'Reset password instructions sent to your email.',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Request failed',
        description:
          error.response?.data?.message ||
          'Could not process forgot password request.',
      })
    },
  })
}

/**
 * Hook for password reset functionality
 * Uses React Query's useMutation for state management
 */
export function useResetPassword() {
  const { toast } = useToast()

  return useMutation({
    mutationFn: (data: ResetPasswordRequest) => authService.resetPassword(data),

    onSuccess: (data) => {
      // Clean up stored email
      storage.removeItem('resetPasswordEmail')

      toast({
        title: 'Success',
        description: data.message || 'Password has been reset successfully.',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Reset failed',
        description:
          error.response?.data?.message || 'Could not reset password.',
      })
    },
  })
}

/**
 * Hook for email verification functionality
 * @deprecated Use authClient.emailOtp.verifyEmail from @/app/lib/auth-client instead
 */
export function useVerifyEmail() {
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({ email, otp }: { email: string; otp: string }) => {
      // Use Better Auth for email verification
      const result = await authClient.emailOtp.verifyEmail({
        email,
        otp,
      })
      if (result.error) {
        throw new Error(result.error.message || 'Verification failed')
      }
      return result.data
    },

    onSuccess: () => {
      toast({
        title: 'Success',
        description: 'Email verified successfully.',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Verification failed',
        description: error.message || 'Could not verify email.',
      })
    },
  })
}

/**
 * Hook for user logout
 * @deprecated Use logout from useAuth hook in @/hooks/use-auth instead
 */
export function useLogout() {
  const { toast } = useToast()

  return useMutation({
    mutationFn: async () => {
      // Clear token cache
      clearTokenCache()
      // Sign out via Better Auth
      await authClient.signOut()
      return { message: 'Logged out' }
    },

    onSuccess: () => {
      toast({
        title: 'Logged out',
        description: 'You have been logged out successfully.',
      })
      // Redirect to sign-in
      window.location.href = '/sign-in'
    },

    onError: () => {
      // Still redirect even if sign out fails
      clearTokenCache()
      toast({
        variant: 'default',
        title: 'Logged out',
        description: 'You have been logged out.',
      })
      window.location.href = '/sign-in'
    },
  })
}

/**
 * Hook for resending verification email
 * Uses React Query's useMutation for state management
 */
export function useResendVerificationEmail() {
  const { toast } = useToast()

  return useMutation({
    mutationFn: (email: string) => authService.resendVerificationEmail(email),

    onSuccess: () => {
      toast({
        title: 'Success',
        description: 'Verification email sent successfully.',
      })
    },

    onError: (error: any) => {
      toast({
        variant: 'destructive',
        title: 'Failed to send verification email',
        description:
          error.response?.data?.message || 'Could not send verification email.',
      })
    },
  })
}
