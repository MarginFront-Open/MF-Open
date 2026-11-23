'use client'

/**
 * WHAT THIS FILE DOES: The edit-matter dialog — corrects a
 * matter's number, name, or client name in place.
 *
 * WHY IT EXISTS: the client name prints on every audit CSV row, so typos
 * need an in-place fix. Deleting and recreating a matter is not a fix:
 * deleteMatter sends every attributed event back to Unassigned and loses
 * the attribution record.
 *
 * CONNECTS TO: ./matters-tab.tsx (opens it per row),
 * app/actions/matters.ts (upsertMatter does the write).
 */

import { useState, useTransition } from 'react'
import { upsertMatter, type MatterRow } from '@/app/actions/matters'
import { useToast } from '@/hooks/use-toast'
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

export default function MatterEditDialog({
  matter,
  onClose,
  onSaved,
}: {
  matter: MatterRow | null
  onClose: () => void
  onSaved: () => void
}) {
  return (
    <Dialog
      open={matter !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {/* key remounts the form per matter, so its state re-seeds from props
          (seeding via an effect trips react-hooks/set-state-in-effect). */}
      {matter && (
        <MatterEditForm
          key={matter.id}
          matter={matter}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  )
}

function MatterEditForm({
  matter,
  onClose,
  onSaved,
}: {
  matter: MatterRow
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [number, setNumber] = useState(matter.matterNumber)
  const [name, setName] = useState(matter.name)
  const [client, setClient] = useState(matter.clientName)
  const [isPending, startTransition] = useTransition()

  const handleSave = () => {
    startTransition(async () => {
      const result = await upsertMatter({
        id: matter.id,
        matterNumber: number,
        name,
        clientName: client,
        status: matter.status,
        responsibleUserId: matter.responsibleUserId,
      })
      if (!result.success) {
        toast({
          title: 'Matter not saved',
          description: result.error,
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Matter updated' })
      onSaved()
    })
  }

  return (
    <DialogContent className='max-w-md'>
      <DialogHeader>
        <DialogTitle>Edit matter</DialogTitle>
        <DialogDescription>
          Events already attributed to this matter stay attributed; future
          exports print the corrected details.
        </DialogDescription>
      </DialogHeader>
      <div className='flex flex-col gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='edit-matter-number'>Matter number</Label>
          <Input
            id='edit-matter-number'
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
          <p className='text-xs text-muted-foreground'>
            This is also the value metadata.matterId must carry to tag new usage
            to this matter.
          </p>
        </div>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='edit-matter-name'>Matter name</Label>
          <Input
            id='edit-matter-name'
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='edit-matter-client'>Client or team</Label>
          <Input
            id='edit-matter-client'
            value={client}
            onChange={(e) => setClient(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant='outline' onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isPending}>
          Save changes
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
