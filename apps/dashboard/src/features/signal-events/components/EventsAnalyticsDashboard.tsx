'use client'

import { useState } from 'react'
import { format, subDays } from 'date-fns'
import { useEventsAnalytics } from '@/services/signal-events-service'
import Link from 'next/link'
import { CalendarIcon, RefreshCw, Play, Info } from 'lucide-react'
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { useToast } from '@/hooks/use-toast'
import { Page } from '@/components/layouts/page'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import RawEventsTable from './RawEventsTable'

const EventsAnalyticsDashboard = ({
  hidePageWrapper = false,
}: {
  hidePageWrapper?: boolean
}) => {
  const { toast } = useToast()
  const [dateRange, setDateRange] = useState<{
    startDate: Date
    endDate: Date
  }>({
    startDate: subDays(new Date(), 30),
    endDate: new Date(),
  })
  const [chartType, setChartType] = useState<'area' | 'bar'>('bar')

  const { data, isLoading, isError, refetch } = useEventsAnalytics({
    startDate: dateRange.startDate.toISOString(),
    endDate: dateRange.endDate.toISOString(),
  })

  const handleRefresh = () => {
    refetch()
    toast({
      title: 'Refreshing data',
      description: 'Data is being refreshed',
    })
  }

  const handleRetryErrors = () => {
    toast({
      title: 'Retrying errors',
      description: 'Errors are being reprocessed',
    })
  }

  // Format chart data for visualization
  const chartData =
    data?.dateWiseEvents.map((day) => {
      const formattedData: Record<string, any> = {
        date: day.date,
      }

      day.signals.forEach((signal) => {
        formattedData[signal.signalName] = signal.count
      })

      return formattedData
    }) || []

  // Brand colors for charts using CSS variables
  const CHART_COLORS = [
    'hsl(var(--chart-1))',
    'hsl(var(--chart-2))',
    'hsl(var(--chart-3))',
    'hsl(var(--chart-4))',
    'hsl(var(--chart-5))',
    'hsl(var(--chart-1))',
    'hsl(var(--chart-2))',
  ]

  // Generate unique colors for the chart
  const generateChartColors = (count: number) => {
    return Array(count)
      .fill(0)
      .map((_, i) => CHART_COLORS[i % CHART_COLORS.length])
  }

  const formatCount = (value?: number) =>
    typeof value === 'number' ? value.toLocaleString() : '0'

  const signalNames =
    data?.signalDistribution?.map((item) => item.signalName) || []
  const chartColors = generateChartColors(signalNames.length)

  const content = (
    <div className='flex flex-col gap-6'>
      {/* Toolbar - clean minimal design */}
      <div className='flex items-center justify-between gap-4'>
        <div className='flex items-center gap-3'>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant='outline' className='gap-2'>
                <CalendarIcon className='h-4 w-4' />
                {format(dateRange.startDate, 'MMM d')} -{' '}
                {format(dateRange.endDate, 'MMM d, yyyy')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className='w-auto p-0' align='start'>
              <Calendar
                initialFocus
                mode='range'
                defaultMonth={dateRange.startDate}
                selected={{
                  from: dateRange.startDate,
                  to: dateRange.endDate,
                }}
                onSelect={(range) => {
                  if (range?.from && range?.to) {
                    setDateRange({
                      startDate: range.from,
                      endDate: range.to,
                    })
                  }
                }}
              />
            </PopoverContent>
          </Popover>
          <Button onClick={handleRefresh} variant='outline' className='gap-2'>
            <RefreshCw className='h-4 w-4' />
            Refresh
          </Button>
        </div>
        <Button onClick={handleRetryErrors} className='gap-2'>
          <Play className='h-4 w-4' />
          Replay Errors
        </Button>
      </div>

      {isLoading ? (
        <div className='space-y-6'>
          {/* KPI Cards Skeleton */}
          <div className='grid grid-cols-1 gap-6 md:grid-cols-3'>
            {[1, 2, 3].map((i) => (
              <Card key={i} className='border-border/50 shadow-sm'>
                <CardHeader className='pb-2'>
                  <Skeleton className='h-4 w-24' />
                </CardHeader>
                <CardContent>
                  <Skeleton className='h-9 w-28' />
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Processed Events Info Skeleton */}
          <Skeleton className='h-4 w-64' />

          {/* Error Summary Table Skeleton */}
          <Card className='border-border/50 shadow-sm'>
            <CardHeader>
              <Skeleton className='h-6 w-36' />
            </CardHeader>
            <CardContent>
              <div className='space-y-3'>
                <div className='flex items-center gap-4 border-b border-border/30 pb-3'>
                  <Skeleton className='h-4 w-[70%]' />
                  <Skeleton className='h-4 w-[10%]' />
                  <Skeleton className='h-8 w-[15%]' />
                </div>
                {[1, 2, 3].map((i) => (
                  <div key={i} className='flex items-center gap-4 py-2'>
                    <Skeleton className='h-4 w-[70%]' />
                    <Skeleton className='h-4 w-[10%]' />
                    <Skeleton className='h-8 w-[15%]' />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Metric Distribution Skeleton */}
          <Card className='border-border/50 shadow-sm'>
            <CardHeader>
              <Skeleton className='h-6 w-44' />
            </CardHeader>
            <CardContent className='space-y-4'>
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className='space-y-2'>
                  <div className='flex items-center gap-2'>
                    <Skeleton className='h-4 w-32' />
                    <Skeleton className='h-4 w-12' />
                  </div>
                  <Skeleton className='h-4 w-full rounded-full' />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Chart Skeleton */}
          <Card className='border-border/50 shadow-sm'>
            <CardHeader className='flex flex-col items-start justify-between sm:flex-row sm:items-center'>
              <Skeleton className='h-6 w-40' />
              <Skeleton className='mt-2 h-9 w-[180px] sm:mt-0' />
            </CardHeader>
            <CardContent>
              <Skeleton className='h-64 w-full rounded-md' />
            </CardContent>
          </Card>

          {/* Ingestion Log Skeleton */}
          <Card className='border-border/50 shadow-sm'>
            <CardHeader>
              <Skeleton className='h-6 w-28' />
            </CardHeader>
            <CardContent>
              <Skeleton className='mb-4 h-4 w-40' />
              <div className='space-y-3'>
                <div className='flex items-center gap-4 border-b border-border/30 pb-3'>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className='h-4 flex-1' />
                  ))}
                </div>
                {[1, 2, 3, 4, 5].map((row) => (
                  <div key={row} className='flex items-center gap-4 py-2'>
                    {[1, 2, 3, 4, 5].map((col) => (
                      <Skeleton key={col} className='h-4 flex-1' />
                    ))}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : isError ? (
        <Card className='border-destructive/50 bg-destructive/5'>
          <CardContent className='py-6 text-center text-destructive'>
            Failed to load analytics data. Please try again.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary KPIs */}
          <div className='grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4'>
            <Card className='hover-lift border-border/50 shadow-sm'>
              <CardHeader>
                <CardTitle className='text-sm font-medium text-muted-foreground'>
                  Events
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className='text-3xl font-bold'>
                  {formatCount(data?.rawEvents?.total)}
                </p>
              </CardContent>
            </Card>
            <Card className='hover-lift border-border/50 shadow-sm'>
              <CardHeader>
                <CardTitle className='text-sm font-medium text-muted-foreground'>
                  Processed
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className='text-3xl font-bold text-theme-accent-600'>
                  {formatCount(data?.rawEvents?.PROCESSED)}
                </p>
              </CardContent>
            </Card>
            <Card className='hover-lift border-border/50 shadow-sm'>
              <CardHeader>
                <CardTitle className='flex items-center gap-1 text-sm font-medium text-muted-foreground'>
                  Errors
                  <TooltipProvider>
                    <UITooltip>
                      <TooltipTrigger asChild>
                        <Info className='h-3 w-3 cursor-help text-muted-foreground/60' />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className='max-w-[200px] text-xs'>
                          Errors are tracked org-wide. They happen before
                          customer/agent filters can be applied.
                        </p>
                      </TooltipContent>
                    </UITooltip>
                  </TooltipProvider>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className='text-3xl font-bold text-destructive'>
                  {formatCount(data?.rawEvents?.ERROR)}
                </p>
              </CardContent>
            </Card>
            <Link href='/metrics-events/needs-attention' className='block'>
              <Card className='hover-lift cursor-pointer border-border/50 shadow-sm transition-colors hover:border-amber-500/50'>
                <CardHeader>
                  <CardTitle className='text-sm font-medium text-muted-foreground'>
                    Needs attention
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className='text-3xl font-bold text-amber-600'>
                    {formatCount(
                      (data?.rawEvents?.NEEDS_COST_BACKFILL ?? 0) +
                        (data?.rawEvents?.MISSING_VOLUME_DATA ?? 0)
                    )}
                  </p>
                </CardContent>
              </Card>
            </Link>
          </div>

          <div className='text-sm text-muted-foreground'>
            Total Quantity: {formatCount(data?.totalQuantity)} units
          </div>

          {/* Metric Distribution */}
          <Card className='hover-lift border-border/50 shadow-sm'>
            <CardHeader>
              <CardTitle className='text-lg font-medium'>
                Metric Distribution
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data?.signalDistribution?.map((signal, idx) => {
                const totalQty = data?.totalQuantity || 1
                const signalQty = signal.totalQuantity || 0
                const percentage = (signalQty / totalQty) * 100
                return (
                  <div key={signal.signalId} className='mb-4'>
                    <div className='mb-1 flex items-center justify-between'>
                      <div className='font-medium'>{signal.signalName}</div>
                      <div className='text-sm text-muted-foreground'>
                        {signalQty.toLocaleString()} units
                        <span className='ml-2 text-xs'>
                          ({signal.count}{' '}
                          {signal.count === 1 ? 'event' : 'events'})
                        </span>
                      </div>
                    </div>
                    <div className='h-3 w-full overflow-hidden rounded-full bg-muted'>
                      <div
                        className='h-full rounded-full'
                        style={{
                          width: `${percentage}%`,
                          backgroundColor:
                            chartColors[idx % chartColors.length],
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          {/* Events Over Time Chart */}
          <Card className='hover-lift border-border/50 shadow-sm'>
            <CardHeader className='flex flex-col items-start justify-between sm:flex-row sm:items-center'>
              <CardTitle className='text-lg font-medium'>
                Events Over Time
              </CardTitle>
              <div className='mt-2 sm:mt-0'>
                <Tabs
                  value={chartType}
                  onValueChange={(v) => setChartType(v as 'area' | 'bar')}
                >
                  <TabsList className='grid w-[180px] grid-cols-2'>
                    <TabsTrigger value='area'>Area</TabsTrigger>
                    <TabsTrigger value='bar'>Bar</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </CardHeader>
            <CardContent>
              <div className='h-64'>
                <ResponsiveContainer width='100%' height='100%'>
                  {chartType === 'area' ? (
                    <AreaChart
                      data={chartData}
                      margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                    >
                      <XAxis dataKey='date' />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      {signalNames.map((signal, index) => (
                        <Area
                          key={signal}
                          type='monotone'
                          dataKey={signal}
                          stackId='1'
                          stroke={chartColors[index % chartColors.length]}
                          fill={chartColors[index % chartColors.length]}
                        />
                      ))}
                    </AreaChart>
                  ) : (
                    <BarChart
                      data={chartData}
                      margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                    >
                      <XAxis dataKey='date' />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      {signalNames.map((signal, index) => (
                        <Bar
                          key={signal}
                          dataKey={signal}
                          stackId='a'
                          fill={chartColors[index % chartColors.length]}
                        />
                      ))}
                    </BarChart>
                  )}
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Ingestion Log */}
          <Card className='hover-lift border-border/50 shadow-sm'>
            <CardHeader>
              <CardTitle className='text-lg font-medium'>
                Ingestion Log
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className='mb-4 text-sm text-muted-foreground'>
                Showing latest 10 events
              </div>
              <RawEventsTable limit={10} showViewAllButton={true} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )

  if (hidePageWrapper) return content

  return (
    <Page
      title='Usage Events'
      headerProps={{
        breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Usage Events' }],
      }}
    >
      {content}
    </Page>
  )
}

export default EventsAnalyticsDashboard
