'use client'

import { format } from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface DatePickerProps {
  value?: Date
  onChange?: (date: Date) => void
  className?: string
  placeholder?: string
}

export function DatePicker({
  value,
  onChange,
  className,
  placeholder = 'Select date',
}: DatePickerProps) {
  const displayValue = value ? format(value, 'MMM d, yyyy') : placeholder

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          className={cn(
            'w-[200px] justify-start text-left font-normal',
            className
          )}
        >
          <CalendarIcon className='mr-2 h-4 w-4' />
          {displayValue}
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-auto p-4' align='start'>
        <p className='text-sm text-muted-foreground'>
          Date picker component - implement with a calendar library
        </p>
      </PopoverContent>
    </Popover>
  )
}
