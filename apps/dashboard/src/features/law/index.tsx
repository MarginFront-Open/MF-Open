'use client'

/**
 * WHAT THIS FILE DOES: The Law tab:
 * three sub-tabs (Matters / Rules / Unassigned, registry in law-tabs.ts,
 * same `?tab=` pattern as finops), an always-visible Unassigned count
 * badge, and the per-matter audit export controls.
 *
 * WHY IT EXISTS: bar rules let a firm bill AI work only at actual per-matter
 * cost; this page is where a firm maps its usage to matters and downloads the
 * record that proves it.
 *
 * CONNECTS TO: app/(dashboard)/law/page.tsx (the role-gated route),
 * ./components/* (the three tabs), app/actions/matters.ts (the badge count),
 * app/api/export/matters/route.ts (the CSV downloads).
 */

import { Suspense, useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Download } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getUnassignedCount } from '@/app/actions/matters'
import { LAW_TABS, resolveLawTab } from './law-tabs'
import MattersTab from './components/matters-tab'
import RulesTab from './components/rules-tab'
import UnassignedTab from './components/unassigned-tab'

function exportUrl(format: 'summary' | 'detail', start: string, end: string) {
  const params = new URLSearchParams({ format })
  if (start) params.set('start', start)
  if (end) params.set('end', end)
  return `/api/export/matters?${params.toString()}`
}

function LawInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const activeTab = resolveLawTab(searchParams.get('tab'))
  const handleTabChange = useCallback(
    (tab: string) => {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.set('tab', tab)
      router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false })
    },
    [searchParams, pathname, router]
  )

  // The Unassigned badge: no date window, so it can never read zero while
  // unassigned events exist anywhere in history.
  const [unassignedCount, setUnassignedCount] = useState<number | null>(null)
  const refreshUnassignedCount = useCallback(() => {
    getUnassignedCount().then((count) => {
      if (count !== null) setUnassignedCount(count)
    })
  }, [])
  useEffect(() => {
    refreshUnassignedCount()
  }, [refreshUnassignedCount])

  // Export window; empty inputs fall back to the API's last-30-days default.
  const [exportStart, setExportStart] = useState('')
  const [exportEnd, setExportEnd] = useState('')

  return (
    <div className='flex flex-col gap-4 p-4 md:p-6'>
      <div className='flex flex-wrap items-end justify-between gap-3'>
        <div>
          <h1 className='text-xl font-semibold'>Matters</h1>
          <p className='text-sm text-muted-foreground'>
            Map AI spend to the job it belongs to, then export the record.
          </p>
        </div>
        <div className='flex flex-wrap items-end gap-2'>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='law-export-start' className='text-xs'>
              From
            </Label>
            <Input
              id='law-export-start'
              type='date'
              value={exportStart}
              onChange={(e) => setExportStart(e.target.value)}
              className='h-8 w-[150px]'
            />
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='law-export-end' className='text-xs'>
              To
            </Label>
            <Input
              id='law-export-end'
              type='date'
              value={exportEnd}
              onChange={(e) => setExportEnd(e.target.value)}
              className='h-8 w-[150px]'
            />
          </div>
          <Button variant='outline' size='sm' asChild>
            <a href={exportUrl('summary', exportStart, exportEnd)} download>
              <Download className='mr-1 h-3.5 w-3.5' />
              Summary CSV
            </a>
          </Button>
          <Button variant='outline' size='sm' asChild>
            <a href={exportUrl('detail', exportStart, exportEnd)} download>
              <Download className='mr-1 h-3.5 w-3.5' />
              Audit detail CSV
            </a>
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          {LAW_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
              {tab.id === 'unassigned' &&
                unassignedCount !== null &&
                unassignedCount > 0 && (
                  <Badge variant='secondary' className='ml-1.5'>
                    {unassignedCount}
                  </Badge>
                )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value='matters'>
          <MattersTab onChanged={refreshUnassignedCount} />
        </TabsContent>
        <TabsContent value='rules'>
          <RulesTab onChanged={refreshUnassignedCount} />
        </TabsContent>
        <TabsContent value='unassigned'>
          <UnassignedTab onChanged={refreshUnassignedCount} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default function Law() {
  // useSearchParams needs a Suspense boundary during prerender (same as the
  // finops page).
  return (
    <Suspense fallback={null}>
      <LawInner />
    </Suspense>
  )
}
