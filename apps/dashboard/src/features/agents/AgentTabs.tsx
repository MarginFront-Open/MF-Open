'use client'

import { ReactNode, useState } from 'react'
import { useAgent, useUpdateAgent } from '@/services/agent-service'
import { useParams } from 'next/navigation'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { Page } from '@/components/layouts/page'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { IconPencil } from '@tabler/icons-react'
import { EditAgentDialog } from './components/edit-agent-dialog'

interface AgentTabsProps {
  activeTab: string
  children?: ReactNode
}

export default function AgentTabs({ activeTab, children }: AgentTabsProps) {
  // Use useParams to get route params
  const params = useParams()
  const agentId = params.agentId as string
  const router = useRouter()
  const { toast } = useToast()

  const { data: agent, isLoading } = useAgent(agentId)
  const updateAgentMutation = useUpdateAgent(agentId)

  // State for activation dialog
  const [showActivationDialog, setShowActivationDialog] = useState(false)

  // State for the name/description edit dialog
  const [showEditDialog, setShowEditDialog] = useState(false)

  const _handleTabChange = (value: string) => {
    router.push(`/agents/${agentId}/${value}`)
  }

  const handleToggleAgent = () => {
    if (agent?.isActive) {
      // If agent is active, show confirmation dialog before deactivating
      setShowActivationDialog(true)
    } else {
      // If agent is inactive, show confirmation dialog before activating
      setShowActivationDialog(true)
    }
  }

  const updateAgentStatus = (newStatus: boolean) => {
    updateAgentMutation.mutate(
      { isActive: newStatus },
      {
        onSuccess: () => {
          toast({
            title: newStatus ? 'Agent Activated' : 'Agent Deactivated',
            description: newStatus
              ? 'The agent is now live and available.'
              : 'The agent has been deactivated.',
          })
          setShowActivationDialog(false)
        },
      }
    )
  }

  const tabDisplayNames: Record<string, string> = {
    signals: 'Metrics',
    'pricing-plans': 'Pricing Plans',
    'revenue-simulator': 'Revenue Simulator',
  }

  // Agent-name crumb goes straight to Build's drill-in because the
  // /agents/[agentId] route only redirects.
  const getBreadcrumb = () => {
    return [
      { name: 'Home', href: '/' },
      { name: 'AI Agents', href: '/build' },
      { name: agent?.name || 'Agent', href: `/build?agent=${agentId}` },
      { name: tabDisplayNames[activeTab] || activeTab },
    ]
  }

  const getPageTitle = () => {
    return tabDisplayNames[activeTab] || 'Agent'
  }

  if (isLoading) {
    return (
      <Page
        title='Loading...'
        headerProps={{
          breadcrumb: [
            { name: 'Home', href: '/' },
            { name: 'AI Agents', href: '/build' },
            { name: 'Loading...' },
          ],
        }}
      >
        <div className='space-y-6'>
          {/* Tab skeleton */}
          <div className='-mx-4 flex gap-6 border-b border-border/50 px-4 pb-3 md:-mx-6 md:px-6'>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-5 w-20' />
            ))}
          </div>

          {/* Header skeleton */}
          <div className='flex items-center justify-between'>
            <div className='space-y-2'>
              <Skeleton className='h-7 w-48' />
              <Skeleton className='h-4 w-72' />
            </div>
            <Skeleton className='h-9 w-24' />
          </div>

          {/* Content skeleton based on active tab */}
          {activeTab === 'signals' && (
            <div className='space-y-4'>
              <div className='grid grid-cols-[1fr_150px_200px_50px] gap-4 px-4'>
                <Skeleton className='h-4 w-16' />
                <Skeleton className='h-4 w-24' />
                <Skeleton className='h-4 w-12' />
                <Skeleton className='h-4 w-12' />
              </div>
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className='grid grid-cols-[1fr_150px_200px_50px] gap-4'
                >
                  <Skeleton className='h-10 w-full' />
                  <Skeleton className='h-10 w-full' />
                  <div className='flex gap-2'>
                    <Skeleton className='h-8 w-24' />
                    <Skeleton className='h-8 w-24' />
                  </div>
                  <Skeleton className='mx-auto h-10 w-10' />
                </div>
              ))}
            </div>
          )}

          {(activeTab === 'pricing-plans' ||
            activeTab === 'revenue-simulator' ||
            activeTab === 'cost-configuration') && (
            <div className='space-y-4'>
              {[1, 2, 3].map((i) => (
                <div key={i} className='space-y-4 rounded-lg border p-6'>
                  <div className='flex items-center justify-between'>
                    <Skeleton className='h-5 w-32' />
                    <Skeleton className='h-6 w-16' />
                  </div>
                  <Skeleton className='h-4 w-full' />
                  <Skeleton className='h-4 w-3/4' />
                </div>
              ))}
            </div>
          )}
        </div>
      </Page>
    )
  }

  return (
    <>
      <Page
        title={getPageTitle()}
        headerProps={{
          breadcrumb: getBreadcrumb(),
          tabs: [
            {
              title: 'Metrics',
              href: `/agents/${agentId}/signals`,
              isActive: activeTab === 'signals',
            },
            {
              title: 'Pricing Plans',
              href: `/agents/${agentId}/pricing-plans`,
              isActive: activeTab === 'pricing-plans',
            },
            {
              title: 'Revenue Simulator',
              href: `/agents/${agentId}/revenue-simulator`,
              isActive: activeTab === 'revenue-simulator',
            },
          ],
          actionButtons: (
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setShowEditDialog(true)}
                className='flex items-center gap-1.5'
              >
                <IconPencil size={14} />
                Edit agent
              </Button>
              <div className='flex items-center gap-2'>
                <span
                  className={`text-sm font-medium ${agent?.isActive ? 'text-theme-accent-600' : 'text-muted-foreground'}`}
                >
                  {agent?.isActive ? 'Live' : 'Offline'}
                </span>
                <Switch
                  checked={agent?.isActive || false}
                  onCheckedChange={handleToggleAgent}
                  disabled={updateAgentMutation.isPending}
                  className='data-[state=checked]:bg-theme-accent-500 data-[state=unchecked]:bg-theme-neutral-300 dark:data-[state=unchecked]:bg-theme-neutral-500'
                />
              </div>
            </div>
          ),
        }}
      >
        {children}
      </Page>

      {agent && (
        <EditAgentDialog
          key={String(showEditDialog)}
          agentId={agentId}
          initialName={agent.name}
          initialDescription={agent.description || ''}
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
        />
      )}

      {/* Confirmation dialog for agent activation/deactivation */}
      <AlertDialog
        open={showActivationDialog}
        onOpenChange={setShowActivationDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {agent?.isActive ? 'Deactivate Agent?' : 'Activate Agent?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {agent?.isActive
                ? 'Are you sure you want to deactivate this agent? This will make it unavailable for use.'
                : 'Are you sure you want to activate this agent? This will make it available for use.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateAgentMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => updateAgentStatus(!agent?.isActive)}
              disabled={updateAgentMutation.isPending}
            >
              {updateAgentMutation.isPending
                ? 'Processing...'
                : agent?.isActive
                  ? 'Deactivate'
                  : 'Activate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
