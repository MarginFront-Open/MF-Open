'use client'

/**
 * Internal AI Spend: the standalone page
 * (/internal-ai-spend), the non-technical
 * decision-maker's home for code-cost-clarity spend caps: caps on the
 * org's OWN coding-agent spend (Claude Code, Codex), never its customer billing; every number here
 * rides the shared cccInternalEventFilter. Sub-tabs: Internal Setup (the
 * pointer trio + coverage + install kit), AI spend, and Caps. A fresh org
 * lands on Internal Setup; an org with coding-agent activity lands on AI
 * spend. Writes go through the role-gated api-nest API (via the
 * spend-controls server actions), never a direct Prisma write.
 *
 * Honesty rails baked in: track vs enforce is always explicit; absent spend
 * renders as "no data yet", never $0; every number carries a freshness label;
 * the cap editor renders only for owner/finance (CAP_MANAGE_ROLES) while
 * everyone else sees caps read-only with a line saying who can change them (the
 * server enforces regardless — this gating is UX, not security).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { captureException } from '@sentry/nextjs'
import { formatCost } from '@/lib/canon-format'
import {
  TileFrame,
  type TileState,
} from '@/features/dashboard-shell/tiles/tile-frame'
import { PageShell } from '@/features/dashboard-shell/page-shell'
import type { DateRangeConfig } from '@/features/dashboard-shell/types'
import { Badge } from '@/components/ui/badge'
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
import { toast } from '@/hooks/use-toast'
import {
  getSpendControlsData,
  createCap,
  updateCap,
  deleteCap,
} from '@/app/actions/spend-controls'
import {
  CAP_MODES,
  CAP_PERIODS,
  type CapActionResult,
  type CapMode,
  type CapPeriod,
  type CapScope,
  type CapView,
  type SpendControlsData,
} from '@/features/money/spend-controls-types'
import {
  alertRecipientsLine,
  buildCapSentence,
  checkAmountAgainstCeiling,
  toolCoverageLine,
  clampToolCoverage,
  CAP_NO_BAR_PROVIDER,
  CAP_NO_BAR_TEAM,
  COVERAGE_CHECK_SCOPE_NOTE,
  COVERAGE_CODEX_SCOPE_NOTE,
  COVERAGE_NO_ACTIVITY_LINE,
  COVERAGE_ROSTER_NOTE,
  COVERAGE_SEPARATE_COUNTS_NOTE,
  COVERAGE_UNKNOWN_NOTE,
  freshnessLabel,
  modeCopy,
  paceCopy,
  pickApplicableCeiling,
  projectPace,
  PERIOD_LABELS,
} from './spend-controls-utils'
import { sourceRepoUrl } from '@/config/source-install'
import { CCC_DOCS_URL, CCC_WINDOWS_DOCS_URL } from './install-kit'
import { InstallKitDialog } from './components/install-kit-dialog'
import { RepoSpendSection } from './components/repo-spend-section'

/**
 * The page's one canonical label. api-nest's cap-alert emails tell users to
 * open this page by name, and cap-alert-copy.spec.ts regex-reads THIS constant
 * so the two apps' labels can never drift. Change both together.
 */
export const INTERNAL_AI_SPEND_PAGE_TITLE = 'Internal AI Spend'

// Shell-only page: no date-range control and no per-user layout, so it stays
// out of DASHBOARD_PAGE_IDS (that union drives layout storage + metrics scopes).
const NO_DATE_RANGE: DateRangeConfig = { modes: [], default: null }

type SubTab = 'setup' | 'spend' | 'caps'

const SUB_TABS: ReadonlyArray<{ id: SubTab; label: string }> = [
  { id: 'setup', label: 'Internal Setup' },
  { id: 'spend', label: 'AI spend' },
  { id: 'caps', label: 'Caps' },
]

export default function InternalAiSpend() {
  return (
    <PageShell
      page='internal-ai-spend'
      title={INTERNAL_AI_SPEND_PAGE_TITLE}
      dateRange={NO_DATE_RANGE}
      editable={false}
    >
      <InternalAiSpendContent />
    </PageShell>
  )
}

function InternalAiSpendContent() {
  const [data, setData] = useState<SpendControlsData | null>(null)
  const [state, setState] = useState<TileState>('loading')
  const [reloadKey, setReloadKey] = useState(0)
  const [kitOpen, setKitOpen] = useState(false)
  const sourceUrl = sourceRepoUrl()
  // null until the user picks: the default sub-tab is data-driven below.
  const [subTab, setSubTab] = useState<SubTab | null>(null)

  // Same fetch-effect shape as the money tabs (see money-invoices-tab):
  // setState only inside the .then callback with a cancelled guard. A post-write
  // refresh bumps reloadKey and keeps the current view on screen while the new
  // data loads, instead of flashing the page back to a skeleton.
  useEffect(() => {
    let cancelled = false
    getSpendControlsData()
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setData(res.data)
          setState('ready')
        } else {
          setState('error')
        }
      })
      // Without this a rejected action leaves state on 'loading' forever, so the
      // page's own error copy never renders and the user sees a skeleton.
      .catch((err) => {
        captureException(err)
        if (cancelled) return
        setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const refresh = useCallback(() => setReloadKey((k) => k + 1), [])

  if (state !== 'ready' || !data) {
    return (
      <TileFrame
        state={state === 'ready' ? 'empty' : state}
        errorMessage="We couldn't load your spend controls. Refresh to try again."
        emptyMessage='No spend controls yet.'
      >
        <div />
      </TileFrame>
    )
  }

  const nowMs = data.asOfMs
  // Per tool, never blended: one number across both tools would overstate
  // Codex coverage.
  // Clamped HERE, once, so the sentence and the caveat below it read the same
  // numbers. Reading raw counts for one and clamped counts for the other is how
  // you end up showing "5 of 5 covered" beside "we can't tell for 5 of them".
  const claudeCoverage = clampToolCoverage(data.coverage.claudeCode)
  const codexCoverage = clampToolCoverage(data.coverage.codex)
  const anyToolActivity = claudeCoverage.total > 0 || codexCoverage.total > 0
  const anyUnknown = claudeCoverage.unknown > 0 || codexCoverage.unknown > 0
  const canManage = data.permission.canManage
  const activeSubTab = subTab ?? (anyToolActivity ? 'spend' : 'setup')

  return (
    <div className='flex flex-col gap-4'>
      <p className='text-[11.5px] text-mf-tx3'>
        These caps control what your own team spends on AI tools (Claude Code,
        Codex). They never touch what you bill your customers.
      </p>

      <div className='inline-flex overflow-hidden rounded-mf-seg-item border border-mf-bd'>
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type='button'
            onClick={() => setSubTab(tab.id)}
            className={
              'px-3 py-1 text-[11.5px] font-medium ' +
              (activeSubTab === tab.id
                ? 'bg-mf-accent text-white'
                : 'bg-mf-card2 text-mf-tx2 hover:text-mf-tx')
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeSubTab === 'spend' ? <RepoSpendSection /> : null}

      {activeSubTab === 'caps' ? (
        <>
          {/* ── How enforcement works ── */}
          <section className='rounded-mf-card border border-mf-bd bg-mf-card2 px-[17px] py-3'>
            <p className='text-[12.5px] font-semibold text-mf-tx'>
              How a cap actually works
            </p>
            <ul className='mt-1 list-disc pl-4 text-[11.5px] text-mf-tx2'>
              <li>
                A cap set to <span className='font-semibold'>track</span> only
                watches and warns. It never stops anyone.
              </li>
              <li>
                A cap set to <span className='font-semibold'>enforce</span>{' '}
                stops Claude Code and Codex work once the team hits the cap, on
                machines where this cap is armed.
              </li>
              <li>
                A cap for one teammate stops work only on that teammate&apos;s
                machine.
              </li>
            </ul>
            <p className='mt-2 text-[11.5px] text-mf-tx2'>
              {alertRecipientsLine(data.alerts)}
            </p>
            <p className='mt-2 text-[11.5px] text-mf-tx3'>
              This is a guardrail, not a hard limit. It tracks spend and can
              pause Claude Code and Codex tool calls on machines where it&apos;s
              installed. Spend from other AI tools (Gemini, xAI) counts toward a
              cap but isn&apos;t paused. It can&apos;t stop charges at Anthropic
              or OpenAI, and it won&apos;t catch a machine that never installed
              it. For a hard ceiling, set a spend limit in your Anthropic
              Console or OpenAI account. You&apos;re responsible for your actual
              provider charges.
            </p>
          </section>

          <section className='flex flex-col gap-2'>
            <div className='flex items-center justify-between'>
              <p className='text-[13px] font-semibold text-mf-tx'>Your caps</p>
              {!canManage ? (
                <span className='text-[11px] text-mf-tx3'>
                  {data.permission.whoCanChange}
                </span>
              ) : null}
            </div>
            {data.caps.length === 0 ? (
              <p className='rounded-mf-card border border-dashed border-mf-bd px-[17px] py-4 text-[11.5px] text-mf-tx3'>
                No caps yet. {canManage ? 'Set one below.' : ''}
              </p>
            ) : (
              data.caps.map((cap) => (
                <CapRow
                  key={cap.id}
                  cap={cap}
                  nowMs={nowMs}
                  canManage={canManage}
                  onChanged={refresh}
                />
              ))
            )}
          </section>

          {canManage ? <CapCreateForm data={data} onCreated={refresh} /> : null}
        </>
      ) : null}

      {activeSubTab === 'setup' ? (
        <>
          {/* The pointer trio: where to install the meter, before
              any coverage or kit content makes sense. */}
          <section className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-4'>
            <p className='text-[15px] font-semibold text-mf-tx'>
              Start here: install the meter
            </p>
            <p className='mt-1 text-[11.5px] text-mf-tx2'>
              Install the meter on each teammate&apos;s machine first, then come
              back here to watch spend and set caps.
            </p>
            <ul className='mt-3 flex flex-col gap-2 text-[11.5px]'>
              {CCC_DOCS_URL ? (
                <li>
                  <a
                    href={CCC_DOCS_URL}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='font-medium text-mf-tx2 underline hover:text-mf-tx'
                  >
                    How Code Cost Clarity works (docs)
                  </a>
                </li>
              ) : null}
              <li>
                <p className='text-mf-tx3'>
                  On Windows? The same command works in PowerShell 7 or newer.
                  No WSL needed. One Windows gap: the Claude desktop app
                  isn&apos;t counted yet, only Claude Code in the terminal.
                  Codex is counted either way.
                  {CCC_WINDOWS_DOCS_URL ? (
                    <>
                      {' '}
                      Follow the{' '}
                      <a
                        href={CCC_WINDOWS_DOCS_URL}
                        target='_blank'
                        rel='noopener noreferrer'
                        className='underline hover:text-mf-tx'
                      >
                        Windows setup guide
                      </a>
                      .
                    </>
                  ) : null}
                </p>
              </li>
              <li>
                {sourceUrl ? (
                  <a
                    href={sourceUrl}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='font-medium text-mf-tx2 underline hover:text-mf-tx'
                  >
                    The source code: packages/code-cost-clarity
                  </a>
                ) : (
                  <span className='text-mf-tx3'>
                    The source code: packages/code-cost-clarity in your
                    MarginFront source
                  </span>
                )}
              </li>
              <li>
                <Link
                  href='/developer-zone/getting-started?method=ccc'
                  className='font-medium text-mf-tx2 underline hover:text-mf-tx'
                >
                  Prefer step by step? Open the guided walkthrough
                </Link>
              </li>
            </ul>
          </section>

          <section className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-4'>
            {anyToolActivity ? (
              <>
                <p className='text-[15px] font-semibold text-mf-tx'>
                  {toolCoverageLine('Claude Code', claudeCoverage)}
                </p>
                <p className='mt-1 text-[15px] font-semibold text-mf-tx'>
                  {toolCoverageLine('Codex', codexCoverage)}
                </p>
              </>
            ) : (
              <p className='text-[15px] font-semibold text-mf-tx'>
                {COVERAGE_NO_ACTIVITY_LINE}
              </p>
            )}
            <p className='mt-1 text-[11.5px] text-mf-tx3'>
              {COVERAGE_ROSTER_NOTE}
            </p>
            {anyToolActivity ? (
              <>
                <p className='mt-1 text-[11.5px] text-mf-tx3'>
                  {COVERAGE_SEPARATE_COUNTS_NOTE}
                </p>
                <p className='mt-1 text-[11.5px] text-mf-tx3'>
                  {COVERAGE_CHECK_SCOPE_NOTE}
                </p>
              </>
            ) : null}
            {anyUnknown ? (
              <p className='mt-1 text-[11.5px] text-mf-tx3'>
                {COVERAGE_UNKNOWN_NOTE}
              </p>
            ) : null}
            {codexCoverage.total > 0 ? (
              <p className='mt-1 text-[11.5px] text-mf-tx3'>
                {COVERAGE_CODEX_SCOPE_NOTE}
              </p>
            ) : null}
            <div className='mt-3'>
              <p className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
                Seen coding
              </p>
              {data.prefill.rosterEmails.length === 0 ? (
                <p className='mt-1 text-[11.5px] text-mf-tx3'>
                  No one seen coding yet.
                </p>
              ) : (
                <div className='mt-1 flex flex-wrap gap-1.5'>
                  {data.prefill.rosterEmails.map((email) => (
                    <span
                      key={email}
                      className='rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2 py-0.5 text-[11px] text-mf-tx2'
                    >
                      {email}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <p className='mt-2 text-[11.5px] text-mf-tx3'>
              {freshnessLabel(data.coverage.asOfMs, nowMs)}.
            </p>
            <p className='mt-2 text-[11.5px] text-mf-tx3'>
              Inviting a teammate gives someone a dashboard login. This list is
              different: it&apos;s who installed the meter and coded. A person
              can have a login and never appear here, and a spare machine or
              test run can appear here without being a person.
            </p>
          </section>

          {/* Send-the-kit opens the install-kit panel (an in-page surface
              the admin copies from — never a public URL or a grid tile). */}
          <section className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-3'>
            <div className='flex items-center justify-between gap-3'>
              <div>
                <p className='text-[12.5px] font-semibold text-mf-tx'>
                  Send the install kit
                </p>
                <p className='mt-0.5 text-[11.5px] text-mf-tx3'>
                  Hand your teammates a one-step install so their caps arm.
                </p>
              </div>
              <Button
                variant='outline'
                onClick={() => {
                  setKitOpen(true)
                }}
              >
                Send the kit
              </Button>
            </div>
          </section>

          <InstallKitDialog
            open={kitOpen}
            onOpenChange={setKitOpen}
            data={data}
          />
        </>
      ) : null}
    </div>
  )
}

// ── One cap: sentence + mode + spend bar + pace, editable for owner/finance ──

function CapRow({
  cap,
  nowMs,
  canManage,
  onChanged,
}: {
  cap: CapView
  nowMs: number
  canManage: boolean
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [amount, setAmount] = useState(String(cap.amountUsd))
  const [mode, setMode] = useState<CapMode>(cap.mode)
  const [busy, setBusy] = useState(false)

  const sentence = buildCapSentence({
    providerScope: cap.providerScope,
    amountUsd: cap.amountUsd,
    scope: cap.scope,
    scopeValue: cap.scopeValue,
    period: cap.period,
  })

  const pace = projectPace({
    spentUsd: cap.spentUsd,
    amountUsd: cap.amountUsd,
    windowStartMs: cap.windowStartMs,
    windowEndMs: cap.windowEndMs,
    nowMs,
  })

  const pct =
    cap.spentUsd !== null && cap.amountUsd > 0
      ? Math.min(100, Math.round((cap.spentUsd / cap.amountUsd) * 100))
      : null

  async function handleSave() {
    const parsed = Number(amount)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast({
        title: 'Enter a dollar amount of 0 or more.',
        variant: 'destructive',
      })
      return
    }
    setBusy(true)
    // Every write handler catches and finally-releases busy. Only
    // the awaited call sits inside the try: a throw from the toast or the
    // refresh below would otherwise fire a failure toast over the success one.
    let res: CapActionResult
    try {
      res = await updateCap(cap.id, { amountUsd: parsed, mode })
    } catch (err) {
      captureException(err)
      toast({
        title:
          "We couldn't reach the server to update the cap. Check your connection and try again.",
        variant: 'destructive',
      })
      return
    } finally {
      setBusy(false)
    }
    if (res.success) {
      toast({ title: 'Cap updated.' })
      setEditing(false)
      onChanged()
    } else {
      toast({ title: res.error, variant: 'destructive' })
    }
  }

  async function handleDelete() {
    setBusy(true)
    let res: CapActionResult
    try {
      res = await deleteCap(cap.id)
    } catch (err) {
      captureException(err)
      toast({
        title:
          "We couldn't reach the server to remove the cap. Check your connection and try again.",
        variant: 'destructive',
      })
      return
    } finally {
      setBusy(false)
    }
    if (res.success) {
      toast({ title: 'Cap removed.' })
      onChanged()
    } else {
      toast({ title: res.error, variant: 'destructive' })
    }
  }

  return (
    <div className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-3'>
      <div className='flex items-start justify-between gap-3'>
        <div className='flex-1'>
          <p className='text-[12.5px] text-mf-tx'>{sentence}</p>
          <div className='mt-1 flex items-center gap-2'>
            <Badge variant={cap.mode === 'enforce' ? 'default' : 'secondary'}>
              {modeCopy(cap.mode).label}
            </Badge>
            <span className='text-[10.5px] text-mf-tx3'>
              {modeCopy(cap.mode).tagline}
            </span>
          </div>
        </div>
        {canManage ? (
          <div className='flex shrink-0 gap-1'>
            <Button
              variant='ghost'
              size='sm'
              disabled={busy}
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? 'Close' : 'Edit'}
            </Button>
            <Button
              variant='ghost'
              size='sm'
              disabled={busy}
              onClick={handleDelete}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </div>

      {/* Spend-vs-cap bar + pace, only where the read model can honestly total
          the spend. Absent spend is "no data yet", never $0. */}
      {cap.spendComputable ? (
        <div className='mt-2'>
          <div className='h-2 w-full overflow-hidden rounded-full bg-mf-card2'>
            <div
              className={
                'h-full rounded-full ' +
                (pct !== null && pct >= 100 ? 'bg-mf-amber' : 'bg-mf-accent')
              }
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>
          <p className='mt-1 text-[11px] text-mf-tx2'>
            {cap.spentUsd === null
              ? 'No spend recorded yet this period.'
              : `${formatCost(cap.spentUsd)} of ${formatCost(cap.amountUsd)} spent`}{' '}
            · {paceCopy(pace)} · {freshnessLabel(nowMs, nowMs)}
          </p>
        </div>
      ) : (
        <p className='mt-2 text-[11px] text-mf-tx3'>
          {cap.scope === 'team' ? CAP_NO_BAR_TEAM : CAP_NO_BAR_PROVIDER}
        </p>
      )}

      {editing && canManage ? (
        <div className='mt-3 flex flex-wrap items-end gap-3 border-t border-mf-bd pt-3'>
          <div>
            <Label className='text-[11px] text-mf-tx3'>Amount ($)</Label>
            <Input
              type='number'
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className='mt-1 w-28'
            />
          </div>
          <ModeToggle mode={mode} onChange={setMode} />
          <Button size='sm' disabled={busy} onClick={handleSave}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  )
}

// ── The sentence builder ──

function CapCreateForm({
  data,
  onCreated,
}: {
  data: SpendControlsData
  onCreated: () => void
}) {
  // 'org' not 'dev': a per-teammate default can't be saved on a fresh org (no
  // teammate is on the meter yet), so the form would read as broken.
  const [scope, setScope] = useState<CapScope>('org')
  const [scopeValue, setScopeValue] = useState<string>('')
  const [period, setPeriod] = useState<CapPeriod>('week')
  const [mode, setMode] = useState<CapMode>('track')
  const [amount, setAmount] = useState<string>(
    data.prefill.typicalWeekUsd !== null
      ? String(Math.max(1, Math.round(data.prefill.typicalWeekUsd)))
      : ''
  )
  const [busy, setBusy] = useState(false)

  const amountNum = Number(amount)
  const applicableCeiling =
    scope === 'org' ? null : pickApplicableCeiling('all', data.orgCeilings)
  const ceilingCheck =
    Number.isFinite(amountNum) && scope !== 'org'
      ? checkAmountAgainstCeiling(amountNum, applicableCeiling)
      : { ok: true, message: null }

  const sentence = useMemo(
    () =>
      buildCapSentence({
        providerScope: 'all',
        amountUsd: Number.isFinite(amountNum) ? amountNum : 0,
        scope,
        scopeValue: scope === 'org' ? null : scopeValue || null,
        period,
      }),
    [amountNum, scope, scopeValue, period]
  )

  async function handleCreate() {
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      toast({
        title: 'Enter a dollar amount of 0 or more.',
        variant: 'destructive',
      })
      return
    }
    if (scope !== 'org' && !scopeValue.trim()) {
      toast({
        title: 'Pick which teammate this cap is for.',
        variant: 'destructive',
      })
      return
    }
    if (!ceilingCheck.ok) {
      toast({
        title: ceilingCheck.message ?? 'Cap exceeds the org ceiling.',
        variant: 'destructive',
      })
      return
    }
    setBusy(true)
    let res: CapActionResult
    try {
      res = await createCap({
        scope,
        scopeValue: scope === 'org' ? undefined : scopeValue.trim(),
        providerScope: 'all',
        amountUsd: amountNum,
        period,
        mode,
      })
    } catch (err) {
      captureException(err)
      toast({
        title:
          "We couldn't reach the server to set the cap. Check your connection and try again.",
        variant: 'destructive',
      })
      return
    } finally {
      setBusy(false)
    }
    if (res.success) {
      toast({ title: 'Cap set.' })
      setScopeValue('')
      onCreated()
    } else {
      toast({ title: res.error, variant: 'destructive' })
    }
  }

  return (
    <section className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-4'>
      <p className='text-[13px] font-semibold text-mf-tx'>Set a cap</p>

      <p className='mt-2 text-[13px] text-mf-tx'>{sentence}</p>
      {data.prefill.typicalWeekUsd !== null ? (
        <p className='mt-0.5 text-[11px] text-mf-tx3'>
          Your team&apos;s typical week is about{' '}
          {formatCost(data.prefill.typicalWeekUsd)}.
        </p>
      ) : null}

      <div className='mt-3 flex flex-wrap items-end gap-3'>
        <Field label='Amount ($)'>
          <Input
            type='number'
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className='w-28'
          />
        </Field>

        <Field label='Applies to'>
          <Select value={scope} onValueChange={(v) => setScope(v as CapScope)}>
            <SelectTrigger className='w-32'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['org', 'dev'] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'org' ? 'Whole team' : 'One teammate'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {scope === 'dev' ? (
          <Field label='Teammate'>
            <Select value={scopeValue} onValueChange={setScopeValue}>
              <SelectTrigger className='w-52'>
                <SelectValue placeholder='Pick a teammate' />
              </SelectTrigger>
              <SelectContent>
                {data.prefill.rosterEmails.length === 0 ? (
                  <SelectItem value='__none' disabled>
                    No teammates seen yet
                  </SelectItem>
                ) : (
                  data.prefill.rosterEmails.map((email) => (
                    <SelectItem key={email} value={email}>
                      {email}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <Field label='Per'>
          <Select
            value={period}
            onValueChange={(v) => setPeriod(v as CapPeriod)}
          >
            <SelectTrigger className='w-28'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CAP_PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {PERIOD_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {/* Mode toggle — explicit and visible, never a buried default. */}
      <div className='mt-3'>
        <Label className='text-[11px] text-mf-tx3'>Mode</Label>
        <div className='mt-1'>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
        <p className='mt-1 text-[11px] text-mf-tx2'>{modeCopy(mode).tagline}</p>
      </div>

      {!ceilingCheck.ok ? (
        <p className='mt-2 text-[11.5px] text-mf-red'>{ceilingCheck.message}</p>
      ) : null}

      <div className='mt-3'>
        <Button disabled={busy || !ceilingCheck.ok} onClick={handleCreate}>
          Set this cap
        </Button>
      </div>
    </section>
  )
}

// ── Shared bits ──

function ModeToggle({
  mode,
  onChange,
}: {
  mode: CapMode
  onChange: (m: CapMode) => void
}) {
  return (
    <div className='inline-flex overflow-hidden rounded-mf-seg-item border border-mf-bd'>
      {CAP_MODES.map((m) => (
        <button
          key={m}
          type='button'
          onClick={() => onChange(m)}
          className={
            'px-3 py-1 text-[11.5px] font-medium ' +
            (mode === m
              ? 'bg-mf-accent text-white'
              : 'bg-mf-card2 text-mf-tx2 hover:text-mf-tx')
          }
        >
          {modeCopy(m).label}
        </button>
      ))}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='flex flex-col'>
      <Label className='text-[11px] text-mf-tx3'>{label}</Label>
      <div className='mt-1'>{children}</div>
    </div>
  )
}
