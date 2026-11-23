'use client'

import { HTMLAttributes, useEffect, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/app/lib/auth-client'
import { useRouter } from 'next/navigation'
import { storage } from '@/lib/storage'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'

type ResetPasswordFormProps = HTMLAttributes<HTMLDivElement>

const formSchema = z
  .object({
    otp: z
      .string()
      .min(1, { message: 'Please enter the verification code' })
      .min(6, { message: 'Verification code must be at least 6 characters' }),
    password: z
      .string()
      .min(1, { message: 'Please enter your new password' })
      .min(7, { message: 'Password must be at least 7 characters long' }),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  })

export function ResetPasswordForm({
  className,
  ...props
}: ResetPasswordFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [email, setEmail] = useState('')
  const router = useRouter()
  const { toast } = useToast()

  useEffect(() => {
    // Get email from localStorage
    const resetEmail = storage.getItem('resetPasswordEmail')
    if (resetEmail) {
      setEmail(resetEmail)
    } else {
      // Redirect to forgot password if email is not found
      toast({
        variant: 'destructive',
        title: 'Email not found',
        description: 'Please request a password reset again.',
      })
      router.push('/forgot-password')
    }
  }, [router, toast])

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      otp: '',
      password: '',
      confirmPassword: '',
    },
  })

  async function onSubmit(data: z.infer<typeof formSchema>) {
    if (!email) {
      toast({
        variant: 'destructive',
        title: 'Email not found',
        description: 'Please request a password reset again.',
      })
      router.push('/forgot-password')
      return
    }

    setIsLoading(true)

    try {
      // Use Better Auth to reset password with OTP
      const result = await authClient.emailOtp.resetPassword({
        email,
        otp: data.otp,
        password: data.password,
      })

      if (result.error) {
        toast({
          variant: 'destructive',
          title: 'Reset failed',
          description: result.error.message || 'Could not reset password',
        })
        return
      }

      toast({
        title: 'Success',
        description: 'Password reset successfully. Please sign in.',
      })

      // Clear stored email
      storage.removeItem('resetPasswordEmail')

      // Redirect to sign in
      router.push('/sign-in')
    } catch (error: any) {
      console.error('Error in reset password:', error)
      toast({
        variant: 'destructive',
        title: 'Reset failed',
        description: error.message || 'An error occurred',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className={cn('grid gap-6', className)} {...props}>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <div className='grid gap-2'>
            <FormField
              control={form.control}
              name='otp'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Verification Code</FormLabel>
                  <FormControl>
                    <Input placeholder='Enter verification code' {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='password'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>New Password</FormLabel>
                  <FormControl>
                    <PasswordInput placeholder='********' {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='confirmPassword'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Confirm Password</FormLabel>
                  <FormControl>
                    <PasswordInput placeholder='********' {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button className='mt-2' disabled={isLoading}>
              {isLoading ? 'Resetting Password...' : 'Reset Password'}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
