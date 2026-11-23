// @ts-nocheck
'use client'

/**
 * useLogin Hook
 * TanStack Query hook for handling user login functionality
 * @deprecated Use authClient.signIn.email from @/app/lib/auth-client instead
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { authClient } from '@/app/lib/auth-client'
import { LoginRequest } from '@/services/auth-service'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'

// @ts-nocheck

/**
 * Hook for handling user login
 * @deprecated Use authClient.signIn.email from @/app/lib/auth-client instead
 * @returns Mutation object for login functionality
 */
export const useLogin = () => {
  const queryClient = useQueryClient()
  const router = useRouter()
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
      // Success toast
      toast({
        title: 'Login successful',
        description: 'Welcome back!',
      })

      // Get redirect URL from query params or default to homepage
      const params = new URLSearchParams(window.location.search)
      const redirectTo = params.get('redirectTo') || '/'
      router.push(redirectTo)

      // Invalidate queries that might depend on authentication state
      queryClient.invalidateQueries({ queryKey: ['user'] })
      queryClient.invalidateQueries({ queryKey: ['organization'] })
    },

    onError: (error: any) => {
      // Display error message
      const errorMessage = error.message || 'Failed to login. Please try again.'

      toast({
        variant: 'destructive',
        title: 'Login failed',
        description: errorMessage,
      })

      console.error('Login error:', errorMessage)
    },
  })
}
