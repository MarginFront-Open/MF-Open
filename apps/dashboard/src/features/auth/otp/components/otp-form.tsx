'use client'

import { HTMLAttributes, useEffect, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/app/lib/auth-client'
import { getPostAuthRedirect } from '@/app/lib/auth-redirect'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { useRouter, useSearchParams } from 'next/navigation'
import { storage } from '@/lib/storage'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from '@/components/ui/input-otp'

type OtpFormProps = HTMLAttributes<HTMLDivElement>

const formSchema = z.object({
  otp: z.string().min(6, { message: 'Please enter the complete OTP code.' }),
})

export function OtpForm({ className, ...props }: OtpFormProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isLoading, setIsLoading] = useState(false)
  const [disabledBtn, setDisabledBtn] = useState(true)
  const [email, setEmail] = useState('')
  const { toast } = useToast()

  useEffect(() => {
    const verificationEmail = storage.getItem('verificationEmail')
    if (verificationEmail) {
      setEmail(verificationEmail)
    } else {
      toast({
        variant: 'destructive',
        title: 'Email not found',
        description: 'Please sign up again.',
      })
      router.push('/sign-up')
    }
  }, [router, toast])

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { otp: '' },
  })

  async function onSubmit(data: z.infer<typeof formSchema>) {
    if (!email) {
      toast({
        variant: 'destructive',
        title: 'Email not found',
        description: 'Please sign up again.',
      })
      router.push('/sign-up')
      return
    }

    setIsLoading(true)

    try {
      // Use Better Auth emailOTP.verifyEmail
      const result = await authClient.emailOtp.verifyEmail({
        email,
        otp: data.otp,
      })

      if (result.error) {
        toast({
          variant: 'destructive',
          title: 'Verification failed',
          description: result.error.message || 'Invalid OTP code',
        })
        return
      }

      toast({
        title: 'Success',
        description: 'Email verified successfully',
      })

      // Clear stored email
      storage.removeItem('verificationEmail')

      // Use unified redirect logic (preserve redirectTo from URL params)
      const { url } = await getPostAuthRedirect(searchParams.get('redirectTo'))
      router.push(url)
    } catch (error: any) {
      console.error('OTP verification error:', error)
      toast({
        variant: 'destructive',
        title: 'Verification failed',
        description: error.message || 'An error occurred during verification',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className={cn('grid gap-4', className)} {...props}>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <div className='grid gap-4'>
            <FormField
              control={form.control}
              name='otp'
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div className='flex justify-center'>
                      <InputOTP
                        maxLength={6}
                        pattern={REGEXP_ONLY_DIGITS}
                        value={field.value}
                        onChange={(value) => {
                          field.onChange(value)
                          setDisabledBtn(value.length !== 6)
                        }}
                      >
                        <InputOTPGroup>
                          <InputOTPSlot index={0} />
                          <InputOTPSlot index={1} />
                          <InputOTPSlot index={2} />
                        </InputOTPGroup>
                        <InputOTPSeparator />
                        <InputOTPGroup>
                          <InputOTPSlot index={3} />
                          <InputOTPSlot index={4} />
                          <InputOTPSlot index={5} />
                        </InputOTPGroup>
                      </InputOTP>
                    </div>
                  </FormControl>
                  <FormMessage className='text-center' />
                </FormItem>
              )}
            />
            <Button
              className='w-full bg-primary text-white hover:bg-primary/90'
              disabled={disabledBtn || isLoading}
            >
              {isLoading ? 'Verifying...' : 'Verify'}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
