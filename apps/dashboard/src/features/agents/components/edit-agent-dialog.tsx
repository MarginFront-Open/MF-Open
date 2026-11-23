'use client'

/**
 * EditAgentDialog — edit surface for an agent's core fields (name,
 * description). Mounted from AgentTabs.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateAgent } from '@/services/agent-service'

interface EditAgentDialogProps {
  agentId: string
  initialName: string
  initialDescription: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function EditAgentDialog({
  agentId,
  initialName,
  initialDescription,
  open,
  onOpenChange,
}: EditAgentDialogProps) {
  const updateAgentMutation = useUpdateAgent(agentId)
  // Draft state resets by remount: the parent keys this dialog on its open
  // flag, so a canceled draft can never resurface on reopen.
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)

  const handleSave = () => {
    if (!name.trim()) return
    updateAgentMutation.mutate(
      { name: name.trim(), description: description.trim() },
      {
        onSuccess: () => {
          onOpenChange(false)
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Edit agent</DialogTitle>
          <DialogDescription>
            Change how this agent shows up across your dashboard. Metrics,
            pricing, and usage history stay exactly as they are.
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <Label htmlFor='edit-agent-name'>Name</Label>
            <Input
              id='edit-agent-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. Outreach Writer'
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='edit-agent-description'>Description</Label>
            <Textarea
              id='edit-agent-description'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder='What does this agent do for your customers?'
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant='ghost'
            onClick={() => onOpenChange(false)}
            disabled={updateAgentMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={updateAgentMutation.isPending || !name.trim()}
          >
            {updateAgentMutation.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
