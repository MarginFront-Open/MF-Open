import { redirect } from 'next/navigation'
import Link from 'next/link'
import { db as prisma } from '@/app/lib/db'
import { getInvoiceTotals as canonGetInvoiceTotals } from '@marginfront/db'
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  Activity,
  Users,
  CreditCard,
  Wallet,
} from 'lucide-react'
import { getPortalSession } from '@/app/lib/portal-auth'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PortalActivityChart } from './_components/PortalActivityChart'

type Range = 'billing' | 'all'

interface PortalHomePageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ range?: string }>
}

const fmtMoney = (amount: number, currency: string) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
  }).format(amount)

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

const fmtDateShort = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export default async function PortalHomePage({
  params,
  searchParams,
}: PortalHomePageProps) {
  const { slug } = await params
  const session = await getPortalSession()

  if (!session) {
    redirect(`/${slug}/login`)
  }

  const sp = await searchParams
  const range: Range = sp?.range === 'all' ? 'all' : 'billing'

  const activeSubscription = await prisma.subscriptions.findFirst({
    where: {
      customerId: session.customerId,
      status: 'active',
      deletedAt: null,
    },
    include: { pricing_plans: true },
    orderBy: { createdAt: 'desc' },
  })

  const billingStart = activeSubscription?.currentBillingPeriodStart ?? null
  const billingEnd = activeSubscription?.currentBillingPeriodEnd ?? null

  const useBillingFilter = range === 'billing' && billingStart && billingEnd
  const dateFilter = useBillingFilter
    ? { gte: billingStart!, lte: billingEnd! }
    : undefined

  const customer = await prisma.customers.findUnique({
    where: { id: session.customerId },
    select: { currency: true, name: true, email: true },
  })

  const currency = customer?.currency || 'USD'

  const eventScope = {
    customerId: session.customerId,
    organizationId: session.organizationId,
    ...(dateFilter ? { usageDate: dateFilter } : {}),
  }

  const invoiceScope = {
    customerId: session.customerId,
    organizationId: session.organizationId,
    deletedAt: null,
    ...(dateFilter ? { invoiceDate: dateFilter } : {}),
  }

  // Canon I3 window — match the portal's current billing-vs-all toggle.
  // Wide window (epoch → now) covers the "All time" case since canon clips
  // by invoiceDate.
  const totalsWindow =
    useBillingFilter && billingStart && billingEnd
      ? { start: billingStart, end: billingEnd }
      : { start: new Date(0), end: new Date() }

  const [taskCount, agentRows, signalEvents, invoiceTotals, listInvoices] =
    await Promise.all([
      prisma.signal_events.count({ where: eventScope }),
      prisma.signal_events.findMany({
        where: eventScope,
        select: {
          agentId: true,
          agents: { select: { name: true, isActive: true } },
        },
        distinct: ['agentId'],
      }),
      prisma.signal_events.findMany({
        where: eventScope,
        select: {
          agentId: true,
          signalId: true,
          usageDate: true,
          quantity: true,
          agents: { select: { name: true } },
          signals: { select: { name: true } },
        },
        orderBy: { usageDate: 'desc' },
      }),
      canonGetInvoiceTotals(prisma, session.organizationId, totalsWindow, {
        customerId: session.customerId,
      }),
      prisma.invoices.findMany({
        where: invoiceScope,
        orderBy: { invoiceDate: 'desc' },
        take: 50,
      }),
    ])

  // Per-invoice refunded total for the list rows. Paid invoices only —
  // refunds can't land on draft/issued/overdue. Hidden when 0, so a
  // row shows a refund only when there's a real one.
  const paidListInvoiceIds = listInvoices
    .filter((inv) => inv.status === 'paid')
    .map((inv) => inv.id)
  const refundsByInvoiceId = new Map<string, number>()
  if (paidListInvoiceIds.length > 0) {
    const refundSums = await prisma.invoice_payments.groupBy({
      by: ['invoiceId'],
      where: { invoiceId: { in: paidListInvoiceIds } },
      _sum: { refunded_amount: true },
    })
    for (const row of refundSums) {
      refundsByInvoiceId.set(
        row.invoiceId,
        Number(row._sum.refunded_amount ?? 0)
      )
    }
  }

  const activeAgents = agentRows.filter(
    (a: { agents?: { isActive?: boolean | null } | null }) =>
      a.agents?.isActive !== false
  ).length

  const totalPaidAmount = invoiceTotals.collected

  const taskGroups = new Map<
    string,
    { agent: string; signal: string; count: number; lastAt: Date }
  >()
  for (const e of signalEvents) {
    const key = `${e.agentId}::${e.signalId ?? 'none'}`
    const existing = taskGroups.get(key)
    const qty = Number(e.quantity ?? 1)
    if (existing) {
      existing.count += qty
      if (e.usageDate > existing.lastAt) existing.lastAt = e.usageDate
    } else {
      taskGroups.set(key, {
        agent: e.agents?.name ?? 'Unknown agent',
        signal: e.signals?.name ?? 'Activity',
        count: qty,
        lastAt: e.usageDate,
      })
    }
  }
  const topTasks = Array.from(taskGroups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  const chartData = buildChartSeries(
    signalEvents,
    range,
    billingStart,
    billingEnd
  )

  const planName = activeSubscription?.pricing_plans?.name ?? 'No active plan'
  const greetingName = customer?.name?.split(' ')[0] ?? 'there'

  return (
    <div className='space-y-6'>
      <header className='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
        <div>
          <h1 className='text-2xl font-semibold tracking-tight text-foreground'>
            Hi {greetingName}
          </h1>
          <p className='text-sm text-muted-foreground'>
            Here&apos;s what {session.organizationName} has done for you.
          </p>
        </div>

        <div className='flex items-center gap-2'>
          <span className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>
            View
          </span>
          <RangeButton slug={slug} current={range} target='billing'>
            This billing period
          </RangeButton>
          <RangeButton slug={slug} current={range} target='all'>
            All time
          </RangeButton>
        </div>
      </header>

      {range === 'billing' && billingStart && billingEnd && (
        <p className='text-xs text-muted-foreground'>
          {fmtDate(billingStart)} to {fmtDate(billingEnd)}
        </p>
      )}
      {range === 'billing' && (!billingStart || !billingEnd) && (
        <p className='text-xs text-muted-foreground'>
          No active billing period yet. Showing all activity instead.
        </p>
      )}

      <section className='grid grid-cols-2 gap-4 md:grid-cols-4'>
        <Tile
          icon={CreditCard}
          label='Current plan'
          value={planName}
          sub={
            activeSubscription?.billingCycle
              ? `Billed ${activeSubscription.billingCycle}`
              : undefined
          }
        />
        <Tile
          icon={Activity}
          label='Usage events'
          value={taskCount.toLocaleString()}
          sub={
            taskCount === 1
              ? '1 usage event in range'
              : `${taskCount.toLocaleString()} usage events in range`
          }
        />
        <Tile
          icon={Users}
          label='Active agents'
          value={activeAgents.toLocaleString()}
          sub={
            activeAgents === 1
              ? '1 agent working for you'
              : 'agents working for you'
          }
        />
        <Tile
          icon={Wallet}
          label='Amount paid'
          value={fmtMoney(totalPaidAmount, currency)}
          sub='in this range'
        />
      </section>

      <section>
        <Card>
          <CardHeader className='border-b bg-muted/20 pb-3 pt-3'>
            <p className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
              Activity over time
            </p>
          </CardHeader>
          <CardContent className='p-4'>
            <PortalActivityChart data={chartData} mode={range} />
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader className='border-b bg-muted/20 pb-3 pt-3'>
            <div className='flex items-center justify-between'>
              <p className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                What your agents did
              </p>
              <Badge variant='secondary' className='text-[11px]'>
                {topTasks.length} {topTasks.length === 1 ? 'group' : 'groups'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className='p-0'>
            {topTasks.length === 0 ? (
              <div className='p-12 text-center text-sm text-muted-foreground'>
                No usage events recorded in this range yet.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className='hover:bg-transparent'>
                    <TableHead>Agent</TableHead>
                    <TableHead>What it did</TableHead>
                    <TableHead className='text-right'>How many times</TableHead>
                    <TableHead className='text-right'>Last</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topTasks.map((t, i) => (
                    <TableRow key={i}>
                      <TableCell className='font-medium text-foreground'>
                        {t.agent}
                      </TableCell>
                      <TableCell className='text-muted-foreground'>
                        {t.signal}
                      </TableCell>
                      <TableCell className='text-right font-semibold tabular-nums text-foreground'>
                        {Math.round(t.count).toLocaleString()}
                      </TableCell>
                      <TableCell className='text-right text-muted-foreground'>
                        {fmtDate(t.lastAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader className='border-b bg-muted/20 pb-3 pt-3'>
            <div className='flex items-center justify-between'>
              <p className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Invoices
              </p>
              <Badge variant='secondary' className='text-[11px]'>
                {listInvoices.length}{' '}
                {listInvoices.length === 1 ? 'invoice' : 'invoices'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className='p-0'>
            {listInvoices.length === 0 ? (
              <div className='p-12 text-center text-sm text-muted-foreground'>
                No invoices in this range yet.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className='hover:bg-transparent'>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className='text-right'>Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listInvoices.map(
                    (inv: {
                      id: string
                      invoiceNumber: string | null
                      invoiceDate: Date
                      status: string | null
                      totalAmount: unknown
                      currency: string | null
                    }) => (
                      <TableRow key={inv.id} className='cursor-pointer'>
                        <TableCell>
                          <Link
                            href={`/${slug}/invoices/${inv.id}`}
                            className='font-medium text-foreground hover:underline'
                          >
                            {inv.invoiceNumber}
                          </Link>
                        </TableCell>
                        <TableCell className='text-muted-foreground'>
                          {fmtDateShort(new Date(inv.invoiceDate))}
                        </TableCell>
                        <TableCell>
                          <InvoiceStatusBadge status={inv.status || 'draft'} />
                        </TableCell>
                        <TableCell className='text-right tabular-nums'>
                          <div className='font-semibold text-foreground'>
                            {fmtMoney(
                              Number(inv.totalAmount),
                              inv.currency || currency
                            )}
                          </div>
                          {(refundsByInvoiceId.get(inv.id) ?? 0) > 0 && (
                            <div className='text-xs text-muted-foreground'>
                              {`-${fmtMoney(
                                refundsByInvoiceId.get(inv.id) ?? 0,
                                inv.currency || currency
                              )} refunded`}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      <p className='text-center text-sm text-muted-foreground'>
        Need to update your info or have a question? Contact{' '}
        <span className='font-medium text-foreground'>
          {session.organizationName}
        </span>
        .
      </p>
    </div>
  )
}

function RangeButton({
  slug,
  current,
  target,
  children,
}: {
  slug: string
  current: Range
  target: Range
  children: React.ReactNode
}) {
  const isActive = current === target
  return (
    <Button
      asChild
      variant={isActive ? 'default' : 'outline'}
      size='sm'
      className='h-8 rounded-md text-xs'
    >
      <Link href={target === 'billing' ? `/${slug}/` : `/${slug}/?range=all`}>
        {children}
      </Link>
    </Button>
  )
}

function Tile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
}) {
  return (
    <Card className='overflow-hidden'>
      <CardHeader className='bg-muted/30 pb-2 pt-3'>
        <p className='flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
          <Icon className='h-3.5 w-3.5' />
          {label}
        </p>
      </CardHeader>
      <CardContent className='pt-3'>
        <p className='truncate text-2xl font-bold tabular-nums text-foreground'>
          {value}
        </p>
        {sub && (
          <p className='mt-0.5 truncate text-xs text-muted-foreground'>{sub}</p>
        )}
      </CardContent>
    </Card>
  )
}

function InvoiceStatusBadge({ status }: { status: string }) {
  const config: Record<
    string,
    { className: string; icon?: React.ElementType }
  > = {
    paid: {
      className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      icon: CheckCircle2,
    },
    pending: {
      className: 'bg-amber-50 text-amber-700 border-amber-200',
      icon: Clock,
    },
    issued: { className: 'bg-slate-50 text-slate-700 border-slate-200' },
    overdue: {
      className: 'bg-red-50 text-red-700 border-red-200',
      icon: AlertTriangle,
    },
    draft: { className: 'bg-slate-50 text-slate-700 border-slate-200' },
    void: { className: 'bg-slate-50 text-slate-700 border-slate-200' },
  }
  const { className, icon: Icon } = config[status] || config.draft
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}
    >
      {Icon && <Icon className='h-3 w-3' />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

function buildChartSeries(
  events: { usageDate: Date; quantity: unknown }[],
  range: Range,
  billingStart: Date | null,
  billingEnd: Date | null
): { label: string; tasks: number }[] {
  if (events.length === 0 && !(billingStart && billingEnd)) {
    return []
  }

  const useDailyBuckets = range === 'billing' && billingStart && billingEnd

  if (useDailyBuckets) {
    const buckets = new Map<string, number>()
    const start = new Date(billingStart!)
    start.setUTCHours(0, 0, 0, 0)
    const end = new Date(billingEnd!)
    end.setUTCHours(0, 0, 0, 0)
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      buckets.set(toDayKey(d), 0)
    }
    for (const e of events) {
      const key = toDayKey(e.usageDate)
      if (buckets.has(key)) {
        buckets.set(key, buckets.get(key)! + Number(e.quantity ?? 1))
      }
    }
    return Array.from(buckets.entries()).map(([key, tasks]) => ({
      label: new Date(key).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      tasks,
    }))
  }

  const buckets = new Map<string, number>()
  for (const e of events) {
    const d = new Date(e.usageDate)
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    buckets.set(key, (buckets.get(key) ?? 0) + Number(e.quantity ?? 1))
  }
  const sortedKeys = Array.from(buckets.keys()).sort()
  return sortedKeys.map((key) => {
    const [year, month] = key.split('-').map(Number)
    const d = new Date(Date.UTC(year, month - 1, 1))
    return {
      label: d.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      tasks: buckets.get(key)!,
    }
  })
}

function toDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
