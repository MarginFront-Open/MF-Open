'use client'

/**
 * The content-area shell the command pages render inside the app chrome
 * (DashboardClientLayout → Main).
 * It does NOT recreate sidebar/header and it MUST NOT contain auth logic:
 * RBAC stays in the server page.tsx above it (requireRouteRoles).
 */

import { useEffect, useState, useTransition } from 'react'
import { useLayout } from '@/context/layout-context'
import { cn } from '@/lib/utils'
import { DateRangeSelector } from './date-range-selector'
import type { PageShellProps } from './types'

export function PageShell({
  page,
  title,
  subtitle,
  dateRange,
  editable = true,
  headerExtras,
  onSaveLayout,
  onCancelEdit,
  onResetLayout,
  children,
}: PageShellProps) {
  const [editing, setEditing] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Breadcrumbs render from the global layout context (SmartBreadcrumbs),
  // which only updates when something calls updateOptions(). The Page
  // wrapper does this in a mount effect, and PageShell must too, or
  // navigating between the 5 command pages (Money/ROI/MF IQ/FinOps/Build)
  // leaves the breadcrumb frozen on whichever page loaded first. Mirrors
  // Page's effect (components/layouts/page.tsx) exactly, including its
  // {title, href, isCurrent} breadcrumb shape.
  const { updateOptions } = useLayout()
  useEffect(() => {
    updateOptions({
      pageTitle: title,
      breadcrumbs: [
        { title: 'Home', href: '/' },
        { title, isCurrent: true },
      ],
    })
  }, [page, title, updateOptions])

  const handleDone = () => {
    if (!onSaveLayout) {
      setEditing(false)
      return
    }
    startTransition(async () => {
      const result = await onSaveLayout()
      if (result.success) {
        setEditing(false)
        setEditError(null)
      } else {
        // Failure keeps edit mode open with the action's error verbatim.
        setEditError(
          result.error ??
            'Saving your layout failed. Your changes are still here. Try Done again.'
        )
      }
    })
  }

  const handleCancel = () => {
    onCancelEdit?.()
    setEditing(false)
    setEditError(null)
  }

  const handleReset = () => {
    if (!onResetLayout) return
    startTransition(async () => {
      const result = await onResetLayout()
      setEditError(result.success ? null : (result.error ?? null))
    })
  }

  return (
    <div
      className='mf-shell bg-mf-bg px-[22px] pb-[26px] pt-5'
      data-page={page}
    >
      <div className='mx-auto flex max-w-[1200px] flex-col gap-4'>
        <header className='flex flex-wrap items-center gap-2'>
          <h1 className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
            {title}
          </h1>
          {subtitle && (
            <span className='rounded-mf-seg-item bg-mf-card2 px-2 py-0.5 text-[11px] font-medium text-mf-tx2'>
              {subtitle}
            </span>
          )}
          <div className='ml-auto flex items-center gap-1.5'>
            {headerExtras}
            <DateRangeSelector config={dateRange} />
            {editable && !editing && (
              <button
                type='button'
                onClick={() => setEditing(true)}
                className='h-7 rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
              >
                Edit layout
              </button>
            )}
          </div>
        </header>

        {editable && editing && (
          <div className='flex flex-wrap items-center gap-2 rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-2.5'>
            <span className='text-[11.5px] font-semibold text-mf-accent'>
              Editing layout
            </span>
            <span className='text-[11.5px] text-mf-tx3'>
              Drag to reorder within a group · KPI tiles stay on top · ＋ to add
            </span>
            <div className='ml-auto flex items-center gap-1.5'>
              {onResetLayout && (
                <button
                  type='button'
                  onClick={handleReset}
                  disabled={pending}
                  className='h-6 rounded-mf-seg-item px-2 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx disabled:opacity-50'
                >
                  Reset to default
                </button>
              )}
              <button
                type='button'
                onClick={handleCancel}
                disabled={pending}
                className='h-6 rounded-mf-seg-item px-2 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx disabled:opacity-50'
              >
                Cancel
              </button>
              <button
                type='button'
                onClick={handleDone}
                disabled={pending}
                className={cn(
                  'h-6 rounded-mf-seg-item bg-mf-accent px-2.5 text-[11.5px] font-semibold text-white',
                  pending && 'opacity-50'
                )}
              >
                Done
              </button>
            </div>
            {editError && (
              <p className='w-full text-[11.5px] text-mf-red'>{editError}</p>
            )}
          </div>
        )}

        <div className='flex flex-col gap-4'>
          {typeof children === 'function' ? children({ editing }) : children}
        </div>
      </div>
    </div>
  )
}
