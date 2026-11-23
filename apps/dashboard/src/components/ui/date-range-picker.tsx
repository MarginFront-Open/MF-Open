'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface DateRange {
  from: Date
  to: Date
}

interface DateRangePickerProps {
  value?: DateRange
  onChange?: (range: DateRange) => void
  className?: string
  placeholder?: string
}

export function DateRangePicker({
  value,
  onChange,
  className,
  placeholder = 'Select date range',
}: DateRangePickerProps) {
  const displayValue = value
    ? `${format(value.from, 'MMM d, yyyy')} - ${format(value.to, 'MMM d, yyyy')}`
    : placeholder

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          className={cn(
            'w-[280px] justify-start text-left font-normal',
            className
          )}
        >
          <CalendarIcon className='mr-2 h-4 w-4' />
          {displayValue}
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-auto p-4' align='start'>
        <p className='text-sm text-muted-foreground'>
          Date range picker component - implement with a calendar library
        </p>
      </PopoverContent>
    </Popover>
  )
}
