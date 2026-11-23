'use client'

import { useState, useEffect } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useCreateOrganization } from '@/services/organization-service'
import { useRouter } from 'next/navigation'
import { useLayout } from '@/context/layout-context'
import { useAuth } from '@/hooks/use-auth'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Logo } from '@/components/layout/logo'

const organizationSchema = z.object({
  name: z.string().min(2, {
    message: 'Organization name must be at least 2 characters.',
  }),
  website: z.string().url({
    message: 'Please enter a valid URL.',
  }),
})

type OrganizationFormValues = z.infer<typeof organizationSchema>

export default function CreateOrganization() {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const router = useRouter()
  const { toast } = useToast()
  const createOrganization = useCreateOrganization()
  const { refreshUser } = useAuth()
  const { updateOptions } = useLayout()

  useEffect(() => {
    updateOptions({
      sidebar: false,
      navbar: false,
    })
  }, [updateOptions])

  const form = useForm<OrganizationFormValues>({
    resolver: zodResolver(organizationSchema),
    defaultValues: {
      name: '',
      website: '',
    },
  })

  const onSubmit = async (data: OrganizationFormValues) => {
    try {
      setIsSubmitting(true)

      const submitData = {
        name: data.name,
        organizationInfo: '',
        website: data.website,
        linkedin: '',
        logo: '',
      }

      await createOrganization.mutateAsync(submitData)

      await refreshUser()

      // Add a small delay to ensure the auth store is updated
      await new Promise((resolve) => setTimeout(resolve, 100))

      router.push('/quick-onboarding')

      toast({
        title: 'Organization created!',
        description: "Now let's set up your billing infrastructure.",
      })
    } catch (error) {
      console.error('Error creating organization:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to create organization',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className='gradient-brand-subtle flex h-svh items-center justify-center p-6'>
      <div className='w-full max-w-[450px] space-y-6'>
        <div className='flex items-center justify-center'>
          <Logo linkToHome={false} size='lg' />
        </div>

        <div className='space-y-1.5 text-center'>
          <h2 className='text-2xl font-bold text-primary dark:text-foreground'>
            Create your organization
          </h2>
          <p className='text-sm text-muted-foreground'>
            Add your details to begin
          </p>
        </div>

        <div className='rounded-xl border border-primary/5 bg-white p-6 shadow-lg shadow-primary/10 dark:border-border dark:bg-card'>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-6'>
              <FormField
                control={form.control}
                name='name'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Organization Name</FormLabel>
                    <FormControl>
                      <Input placeholder='Enter organization name' {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name='website'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Website URL</FormLabel>
                    <FormControl>
                      <Input placeholder='https://example.com' {...field} />
                    </FormControl>
                    <FormDescription>
                      We&apos;ll extract your logo and details automatically.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type='submit'
                className='w-full bg-primary text-white hover:bg-primary/90'
                disabled={isSubmitting}
              >
                {isSubmitting
                  ? 'Creating Organization...'
                  : 'Create organization'}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  )
}
