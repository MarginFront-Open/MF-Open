'use client'

import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { IconArrowRight, IconPlus } from '@tabler/icons-react'
import { useCreateAgent } from '@/services/agent-service'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { Page } from '@/components/layouts/page'

const formSchema = z.object({
  name: z.string().min(1, { message: 'Please enter a name' }),
  description: z.string().min(1, { message: 'Please enter a description' }),
  agentCode: z.string().min(1, { message: 'Please enter agent code' }),
})

export default function NewAgent() {
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()
  const { toast } = useToast()
  const createAgentMutation = useCreateAgent()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      description: '',
      agentCode: '',
    },
  })

  async function handleSubmit() {
    try {
      const values = form.getValues()
      if (!values.name || !values.description || !values.agentCode) {
        toast({
          variant: 'destructive',
          title: 'Validation Error',
          description: 'Please fill in all required fields',
        })
        return
      }

      setIsLoading(true)

      const payload = {
        name: values.name,
        description: values.description,
        agentCode: values.agentCode,
        isActive: false,
      }

      // Create the agent using our mutation hook
      const createdAgent = await createAgentMutation.mutateAsync(payload)

      // Navigate to signals page for the created agent
      router.push(`/agents/${createdAgent.id}/signals`)
    } catch (error) {
      console.error('Error creating agent:', error)
      // The mutation hook shows the error toast.
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Page
      title='New Agent'
      headerProps={{
        breadcrumb: [
          { name: 'Home', href: '/' },
          { name: 'Build', href: '/build' },
          { name: 'New Agent' },
        ],
      }}
    >
      <div className='flex h-full flex-col items-center justify-center p-6'>
        <div className='flex w-full max-w-md flex-col items-center'>
          <div className='mb-8 flex items-center justify-center'>
            <div className='flex size-12 items-center justify-center rounded-full bg-primary/10'>
              <IconPlus className='h-6 w-6 text-primary' />
            </div>
          </div>

          <div className='w-full space-y-5'>
            <div className='space-y-2'>
              <Label htmlFor='name'>Name</Label>
              <Input
                id='name'
                type='text'
                placeholder='Enter agent name'
                value={form.watch('name')}
                onChange={(e) => form.setValue('name', e.target.value)}
              />
            </div>

            <div className='space-y-2'>
              <Label htmlFor='description'>Description</Label>
              <Input
                id='description'
                type='text'
                placeholder='Enter agent description'
                value={form.watch('description')}
                onChange={(e) => form.setValue('description', e.target.value)}
              />
            </div>

            <div className='space-y-2'>
              <Label htmlFor='agentCode' className='flex items-center gap-1'>
                Agent code
                <InfoTooltip {...tooltipDefinitions.agentCode} />
              </Label>
              <Input
                id='agentCode'
                type='text'
                placeholder='Enter unique agent code'
                value={form.watch('agentCode')}
                onChange={(e) => form.setValue('agentCode', e.target.value)}
              />
            </div>

            <Button
              type='button'
              className='mt-6 w-full'
              size='lg'
              onClick={handleSubmit}
              disabled={isLoading}
            >
              {isLoading ? 'CREATING...' : 'NEXT : SIGNALS'}
              <IconArrowRight className='ml-2 h-4 w-4' />
            </Button>
          </div>
        </div>
      </div>
    </Page>
  )
}
