'use client'

import React from 'react'
import { X } from 'lucide-react'
import { useAgents } from '@/services/agent-service'
import { useCustomers } from '@/services/customers-service'
import { useSignals } from '@/services/signal-service'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ERROR is deliberately excluded: a storage failure never writes a
// signal_events row (only a raw_ingest_events one), so an ERROR filter on the
// ingestion log would always return zero. See getEventAnalytics in
// app/actions/signal-events.ts.
const STATUS_OPTIONS = [
  { value: 'PROCESSED', label: 'Processed' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'NEEDS_COST_BACKFILL', label: 'Needs cost backfill' },
  { value: 'MISSING_VOLUME_DATA', label: 'Missing volume' },
] as const

export type EventStatusFilter = (typeof STATUS_OPTIONS)[number]['value']

export interface EventFilters {
  agentId?: string
  customerId?: string
  signalId?: string
  eventProcessed?: EventStatusFilter
  startDate?: string
  endDate?: string
}

// shadcn's Select forbids an empty-string item value, so "no filter" needs a
// real sentinel we map back to undefined on the way out.
const ALL = '__all__'

interface RawEventsFilterBarProps {
  filters: EventFilters
  onChange: (next: EventFilters) => void
}

const RawEventsFilterBar: React.FC<RawEventsFilterBarProps> = ({
  filters,
  onChange,
}) => {
  // These list actions default to limit=10; a dropdown must show the whole
  // set, so ask for up to 100. Past 100 entries the dropdown is incomplete.
  const { data: agentsData } = useAgents({ limit: 100 })
  const { data: customersData } = useCustomers({ limit: 100 })
  const { data: signalsData } = useSignals({ limit: 100 })

  const agents = agentsData?.results ?? []
  const customers = customersData?.results ?? []
  const signals = signalsData?.results ?? []

  const hasActiveFilter = Object.values(filters).some(Boolean)

  const patch = (next: Partial<EventFilters>) =>
    onChange({ ...filters, ...next })

  return (
    <div className='flex flex-wrap items-end gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs text-muted-foreground'>Agent</Label>
        <Select
          value={filters.agentId ?? ALL}
          onValueChange={(v) => patch({ agentId: v === ALL ? undefined : v })}
        >
          <SelectTrigger className='h-9 w-[180px]'>
            <SelectValue placeholder='All agents' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All agents</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name || agent.agentCode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='flex flex-col gap-1'>
        <Label className='text-xs text-muted-foreground'>Customer</Label>
        <Select
          value={filters.customerId ?? ALL}
          onValueChange={(v) =>
            patch({ customerId: v === ALL ? undefined : v })
          }
        >
          <SelectTrigger className='h-9 w-[180px]'>
            <SelectValue placeholder='All customers' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All customers</SelectItem>
            {customers.map((customer) => (
              <SelectItem key={customer.id} value={customer.id}>
                {customer.name || customer.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='flex flex-col gap-1'>
        <Label className='text-xs text-muted-foreground'>Metric</Label>
        <Select
          value={filters.signalId ?? ALL}
          onValueChange={(v) => patch({ signalId: v === ALL ? undefined : v })}
        >
          <SelectTrigger className='h-9 w-[180px]'>
            <SelectValue placeholder='All metrics' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All metrics</SelectItem>
            {signals.map((signal) => (
              <SelectItem key={signal.id} value={signal.id}>
                {signal.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='flex flex-col gap-1'>
        <Label className='text-xs text-muted-foreground'>Status</Label>
        <Select
          value={filters.eventProcessed ?? ALL}
          onValueChange={(v) =>
            patch({
              eventProcessed: v === ALL ? undefined : (v as EventStatusFilter),
            })
          }
        >
          <SelectTrigger className='h-9 w-[180px]'>
            <SelectValue placeholder='All statuses' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUS_OPTIONS.map((status) => (
              <SelectItem key={status.value} value={status.value}>
                {status.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='flex flex-col gap-1'>
        <Label className='text-xs text-muted-foreground'>From</Label>
        <Input
          type='date'
          className='h-9 w-[150px]'
          value={filters.startDate ?? ''}
          max={filters.endDate || undefined}
          onChange={(e) => patch({ startDate: e.target.value || undefined })}
        />
      </div>

      <div className='flex flex-col gap-1'>
        <Label className='text-xs text-muted-foreground'>To</Label>
        <Input
          type='date'
          className='h-9 w-[150px]'
          value={filters.endDate ?? ''}
          min={filters.startDate || undefined}
          onChange={(e) => patch({ endDate: e.target.value || undefined })}
        />
      </div>

      {hasActiveFilter && (
        <Button
          variant='ghost'
          size='sm'
          className='h-9 gap-1 text-muted-foreground'
          onClick={() => onChange({})}
        >
          <X className='h-4 w-4' />
          Clear
        </Button>
      )}
    </div>
  )
}

export default RawEventsFilterBar
