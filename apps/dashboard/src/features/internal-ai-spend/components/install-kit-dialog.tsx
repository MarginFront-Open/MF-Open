'use client'

/**
 * The install-kit panel. Opens from the "Send the
 * install kit" button on the Internal AI Spend page's Internal Setup sub-tab —
 * an in-page surface the admin copies from, NOT a public URL and NOT a
 * dashboard-grid tile. It reuses the caps already loaded by the page
 * (org-scoped, via getSpendControlsData), so it makes no second fetch and
 * has no server action of its own.
 *
 * All copy comes from the pure, tested install-kit generator; this file only
 * lets the admin pick which cap the kit is for, type an optional why-note, and
 * copy the result. The cap sentence is built by buildCapSentence (never
 * re-derived here). An org with zero caps gets the install-only
 * capless kit instead of a dead end.
 */

import { useMemo, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'
import type {
  CapView,
  SpendControlsData,
} from '@/features/money/spend-controls-types'
import { buildCapSentence } from '../spend-controls-utils'
import { sourceRepoUrl } from '@/config/source-install'
import {
  ADMIN_SEND_CHECKLIST,
  CCC_DOCS_URL,
  CCC_WINDOWS_DOCS_URL,
  WINDOWS_WSL_SENTENCE,
  buildCaplessInstallKit,
  buildInstallKit,
  formatArmingAndSupport,
  formatKitPlainText,
} from '../install-kit'

function capSentenceFor(cap: CapView): string {
  return buildCapSentence({
    providerScope: cap.providerScope,
    amountUsd: cap.amountUsd,
    scope: cap.scope,
    scopeValue: cap.scopeValue,
    period: cap.period,
  })
}

/** Prefer an org-ceiling cap (the whole-team bet the kit is usually for); else
 * the first cap. Returns null only when the org has no caps at all. */
function defaultCap(caps: CapView[]): CapView | null {
  return caps.find((c) => c.scope === 'org') ?? caps[0] ?? null
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    toast({ title: 'Copied!' })
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Button variant='outline' size='sm' onClick={handleCopy}>
      {copied ? (
        <Check className='mr-1.5 h-3.5 w-3.5' />
      ) : (
        <Copy className='mr-1.5 h-3.5 w-3.5' />
      )}
      {copied ? 'Copied' : label}
    </Button>
  )
}

export function InstallKitDialog({
  open,
  onOpenChange,
  data,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: SpendControlsData
}) {
  const [selectedCapId, setSelectedCapId] = useState<string>('')
  const [whyNote, setWhyNote] = useState('')
  const sourceUrl = sourceRepoUrl()

  // Resolve the selected cap defensively: the stored id may be empty (first
  // open) or point at a cap a refresh removed, so fall back to the default.
  const selectedCap =
    data.caps.find((c) => c.id === selectedCapId) ?? defaultCap(data.caps)
  const hasCaps = selectedCap !== null

  // Zero caps is not a dead end: the capless kit installs
  // the meter, and a cap set later reaches those machines by itself.
  const kit = useMemo(() => {
    if (!selectedCap) {
      return buildCaplessInstallKit({
        orgName: data.orgName,
        setterName: data.setterName,
      })
    }
    return buildInstallKit({
      orgName: data.orgName,
      capSentence: capSentenceFor(selectedCap),
      mode: selectedCap.mode,
      whyNote,
      setterName: data.setterName,
    })
  }, [selectedCap, data.orgName, data.setterName, whyNote])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] max-w-2xl overflow-y-auto'>
        <DialogHeader>
          <DialogTitle>Send the install kit</DialogTitle>
          <DialogDescription>
            {hasCaps
              ? 'Pick the cap this kit is for, add a short note, then copy it to your teammates. Nothing here changes a cap.'
              : 'Copy this kit to your teammates. It installs the meter now; caps can come later.'}
          </DialogDescription>
        </DialogHeader>

        <div className='flex flex-col gap-4'>
          {/* The admin's pre-send checklist — on-screen guidance for the
                SENDER (coverage + how to get a teammate a key). Deliberately
                not part of the copied kit: formatKitPlainText never includes
                it, and a wiring test pins that split. */}
          <section className='rounded-mf-card border border-mf-bd bg-mf-card2 px-[17px] py-3'>
            <p className='mb-1 text-[12.5px] font-semibold text-mf-tx'>
              {ADMIN_SEND_CHECKLIST.heading}
            </p>
            {ADMIN_SEND_CHECKLIST.lines.map((line, i) => (
              <p key={i} className='text-[11.5px] text-mf-tx2'>
                {line}
              </p>
            ))}
          </section>

          {/* Cap picker + why-note — cap-aware kits only */}
          {hasCaps ? (
            <div className='flex flex-col gap-3'>
              <div className='flex flex-col'>
                <Label className='text-[11px] text-mf-tx3'>
                  Which cap is this kit for?
                </Label>
                <Select
                  value={selectedCap?.id ?? ''}
                  onValueChange={setSelectedCapId}
                >
                  <SelectTrigger className='mt-1'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data.caps.map((cap) => (
                      <SelectItem key={cap.id} value={cap.id}>
                        {capSentenceFor(cap)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className='flex flex-col'>
                <Label className='text-[11px] text-mf-tx3'>
                  A short note for your team (why this cap)
                </Label>
                <Textarea
                  value={whyNote}
                  onChange={(e) => setWhyNote(e.target.value)}
                  placeholder='e.g. We went over budget last month. This keeps us on track.'
                  className='mt-1'
                  rows={2}
                />
              </div>
            </div>
          ) : null}

          {/* The generated kit */}
          <div className='flex items-center justify-between'>
            <p className='text-[13px] font-semibold text-mf-tx'>{kit.title}</p>
            <CopyButton
              text={formatKitPlainText(kit)}
              label='Copy the whole kit'
            />
          </div>

          <KitSection heading={kit.whyNote.heading}>
            {kit.whyNote.lines.map((line, i) => (
              <p key={i} className='text-[11.5px] text-mf-tx2'>
                {line}
              </p>
            ))}
          </KitSection>

          <KitSection heading={kit.keyReady.heading}>
            {kit.keyReady.lines.map((line, i) => (
              <p key={i} className='text-[11.5px] text-mf-tx2'>
                {line}
              </p>
            ))}
          </KitSection>

          <KitSection heading={kit.pathA.heading}>
            <p className='text-[11.5px] text-mf-tx2'>{kit.pathA.intro}</p>
            <div className='mt-2 flex items-center justify-between gap-2 rounded-mf-card bg-mf-card2 px-3 py-2'>
              <code className='overflow-x-auto text-[11.5px] text-mf-tx'>
                {kit.pathA.command}
              </code>
              <CopyButton text={kit.pathA.command} label='Copy' />
            </div>
            <p className='mt-1 text-[11px] text-mf-tx3'>{kit.pathA.after}</p>
            <p className='mt-1 text-[11px] text-mf-tx3'>
              {WINDOWS_WSL_SENTENCE}
              {CCC_WINDOWS_DOCS_URL ? (
                <>
                  {' '}
                  <a
                    href={CCC_WINDOWS_DOCS_URL}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='underline hover:text-mf-tx'
                  >
                    Windows setup guide
                  </a>
                </>
              ) : null}
            </p>
          </KitSection>

          {/* Path B is load-bearing (a coding agent refuses an opaque
                install without the legible policy) but sits behind a
                disclosure so the one-liner reads as the main action. */}
          <details className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-3'>
            <summary className='cursor-pointer text-[12.5px] font-semibold text-mf-tx'>
              Using a coding agent like Claude Code or Codex? Paste this
              instead.
            </summary>
            <div className='mt-2 rounded-mf-card bg-mf-card2 px-3 py-2'>
              <div className='flex justify-end'>
                <CopyButton text={kit.pathB.prompt} label='Copy the prompt' />
              </div>
              <pre className='mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-mf-tx2'>
                {kit.pathB.prompt}
              </pre>
            </div>
          </details>

          <p className='text-[11px] text-mf-tx3'>
            {formatArmingAndSupport(kit)}
          </p>
          {kit.capsLaterNote !== null ? (
            <p className='text-[11px] text-mf-tx3'>{kit.capsLaterNote}</p>
          ) : null}
          {hasCaps ? (
            <p className='text-[11px] text-mf-tx3'>
              Best-effort guardrail, not a hard limit. For a hard ceiling, set a
              spend limit in your Anthropic or OpenAI account.
            </p>
          ) : null}
          <p className='text-[11px] text-mf-tx3'>
            More:{' '}
            {CCC_DOCS_URL ? (
              <>
                <a
                  href={CCC_DOCS_URL}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='underline hover:text-mf-tx'
                >
                  Docs
                </a>
                {' · '}
              </>
            ) : null}
            {sourceUrl ? (
              <a
                href={sourceUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='underline hover:text-mf-tx'
              >
                Source code (packages/code-cost-clarity)
              </a>
            ) : (
              'Source code: packages/code-cost-clarity in your MarginFront source'
            )}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function KitSection({
  heading,
  children,
}: {
  heading: string
  children: React.ReactNode
}) {
  return (
    <section className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-3'>
      <p className='mb-1 text-[12.5px] font-semibold text-mf-tx'>{heading}</p>
      {children}
    </section>
  )
}
