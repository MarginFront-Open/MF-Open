import { IconLock } from '@tabler/icons-react'
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
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface PlanActivationToggleProps {
  isPlanActive: boolean
  showActivationDialog: boolean
  activationPending: boolean
  onToggle: () => void
  onConfirmActivation: () => void
  onCancelActivation: () => void
}

export function PlanActivationToggle({
  isPlanActive,
  showActivationDialog,
  activationPending,
  onToggle,
  onConfirmActivation,
  onCancelActivation,
}: PlanActivationToggleProps) {
  return (
    <>
      <div className='flex items-center gap-2'>
        <Label htmlFor='plan-active-status' className='font-medium'>
          LIVE
        </Label>
        <div className='flex items-center'>
          {isPlanActive && (
            <IconLock size={16} className='mr-2 text-muted-foreground' />
          )}
          {isPlanActive ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className='inline-block cursor-help'>
                    <Switch
                      id='plan-active-status'
                      checked={isPlanActive}
                      onCheckedChange={onToggle}
                      disabled={isPlanActive || activationPending}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className='max-w-xs text-xs'>
                    Once a plan is live, it stays live. Deactivating a live plan
                    would orphan the customers subscribed to it. Move customers
                    to a different plan if you want to retire this one.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Switch
              id='plan-active-status'
              checked={isPlanActive}
              onCheckedChange={onToggle}
              disabled={isPlanActive || activationPending}
            />
          )}
        </div>
      </div>

      <AlertDialog
        open={showActivationDialog}
        onOpenChange={onCancelActivation}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate Plan?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to make this pricing plan live? This will
              make it available for subscriptions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={activationPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmActivation}
              disabled={activationPending}
            >
              {activationPending ? 'Processing...' : 'Activate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
