import * as React from 'react'
import { type DialogProps } from '@radix-ui/react-dialog'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Command as CommandPrimitive } from 'cmdk'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog } from '@/components/ui/dialog'

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
      className
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

interface CommandDialogProps extends DialogProps {
  onOpenChange?: (open: boolean) => void
}

const CommandDialog = ({
  children,
  onOpenChange,
  ...props
}: CommandDialogProps) => {
  return (
    <Dialog {...props} onOpenChange={onOpenChange} modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className='fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0' />
        <DialogPrimitive.Content
          className='fixed left-[50%] top-[50%] z-50 w-full max-w-[640px] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-lg border border-border/50 bg-background p-0 shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]'
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <VisuallyHidden>
            <DialogPrimitive.Title>Command Menu</DialogPrimitive.Title>
          </VisuallyHidden>
          <Command className='[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4 [&_[cmdk-item]_svg]:shrink-0'>
            {children}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  )
}

interface CommandInputProps extends React.ComponentPropsWithoutRef<
  typeof CommandPrimitive.Input
> {
  onClose?: () => void
}

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  CommandInputProps
>(({ className, onClose, ...props }, ref) => (
  <div
    className='flex items-center gap-3 border-b border-border/50 bg-muted/30 px-4 py-3'
    cmdk-input-wrapper=''
  >
    <div className='relative flex-1'>
      <Search className='pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          'flex h-10 w-full rounded-md bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50',
          'pl-10 pr-3',
          'border border-border/60 transition-colors',
          'focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
          'focus-visible:border-2 focus-visible:border-primary/40',
          'focus:outline-none focus:ring-0 focus:ring-offset-0',
          'focus:border-2 focus:border-primary/40',
          className
        )}
        {...props}
      />
    </div>
    {onClose && (
      <button
        type='button'
        onClick={onClose}
        className='flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground transition-all duration-200 hover:border-primary/40 hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30'
      >
        <X className='h-4 w-4' />
      </button>
    )}
  </div>
))

CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('overflow-y-auto overflow-x-hidden p-2', className)}
    {...props}
  />
))

CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className='py-8 text-center text-sm text-muted-foreground'
    {...props}
  />
))

CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground',
      className
    )}
    {...props}
  />
))

CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn('mx-2 my-1 h-px bg-border/50', className)}
    {...props}
  />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center rounded-md px-3 py-2.5 text-sm outline-none transition-colors hover:bg-accent/50 data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:bg-accent/80 data-[selected='true']:text-accent-foreground data-[disabled=true]:opacity-50",
      className
    )}
    {...props}
  />
))

CommandItem.displayName = CommandPrimitive.Item.displayName

const CommandShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn(
        'ml-auto text-xs tracking-widest text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}
CommandShortcut.displayName = 'CommandShortcut'

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
