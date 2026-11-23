'use client'

import { HTMLAttributes, useRef, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/app/lib/auth-client'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
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

type ForgotFormProps = HTMLAttributes<HTMLDivElement>

const formSchema = z.object({
  email: z
    .string()
    .min(1, { message: 'Please enter your email' })
    .email({ message: 'Invalid email address' }),
})

export function ForgotForm({ className, ...props }: ForgotFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileInstance | null>(null)
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  const turnstileEnabled = Boolean(turnstileSiteKey)
  const router = useRouter()
  const { toast } = useToast()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: '' },
  })

  async function onSubmit(data: z.infer<typeof formSchema>) {
    setIsLoading(true)

    try {
      // Cast: Better-Auth's client types don't know about custom body fields;
      // the server's hooks.before reads ctx.body.turnstileToken regardless.
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: data.email,
        type: 'forget-password',
        turnstileToken: turnstileToken ?? '',
      } as any)

      if (result.error) {
        toast({
          variant: 'destructive',
          title: 'Request failed',
          description: result.error.message || 'Could not send reset code',
        })
        // Reset Turnstile so the user gets a fresh token on retry.
        turnstileRef.current?.reset()
        setTurnstileToken(null)
        return
      }

      toast({
        title: 'Success',
        description: 'Reset code sent to your email',
      })

      // Store email in localStorage for reset password page
      storage.setItem('resetPasswordEmail', data.email)

      // Redirect to reset password page
      router.push('/reset-password')
    } catch (error: any) {
      console.error('Error in forgot password:', error)
      toast({
        variant: 'destructive',
        title: 'Request failed',
        description: error.message || 'An error occurred',
      })
      turnstileRef.current?.reset()
      setTurnstileToken(null)
    } finally {
      setIsLoading(false)
    }
  }

  const isSubmitBlocked = isLoading || (turnstileEnabled && !turnstileToken)

  return (
    <div className={cn('grid gap-6', className)} {...props}>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <div className='grid gap-2'>
            <FormField
              control={form.control}
              name='email'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input placeholder='name@example.com' {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {turnstileEnabled && (
              <div className='mt-2 flex justify-center'>
                <Turnstile
                  ref={turnstileRef}
                  siteKey={turnstileSiteKey!}
                  onSuccess={setTurnstileToken}
                  onError={() => setTurnstileToken(null)}
                  onExpire={() => setTurnstileToken(null)}
                  options={{ theme: 'auto' }}
                />
              </div>
            )}
            <Button className='mt-2' disabled={isSubmitBlocked}>
              {isLoading ? 'Sending...' : 'Send Reset Code'}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
