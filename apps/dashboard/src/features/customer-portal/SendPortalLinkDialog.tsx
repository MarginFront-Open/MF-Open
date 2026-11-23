'use client'

import { useState, useEffect } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Mail,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { generateCustomerPortalLink } from '@/app/actions/generate-customer-portal-link'
import { sendCustomerPortalLink } from '@/app/actions/send-customer-portal-link'

type DialogStatus = 'idle' | 'minting' | 'ready' | 'sending' | 'sent' | 'error'

interface SendPortalLinkDialogProps {
  customer: {
    id: string
    name: string
    email: string | null
  }
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SendPortalLinkDialog({
  customer,
  open,
  onOpenChange,
}: SendPortalLinkDialogProps) {
  const [status, setStatus] = useState<DialogStatus>('idle')
  const [portalUrl, setPortalUrl] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [copied, setCopied] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on open */
  useEffect(() => {
    if (open) {
      setStatus('minting')
      setPortalUrl(null)
      setExpiresAt(null)
      setErrorMessage('')
      setCopied(false)
      generateCustomerPortalLink(customer.id)
        .then((result) => {
          if (!result.success || !result.data) {
            setStatus('error')
            setErrorMessage(result.error ?? 'Could not create the link.')
            return
          }
          setPortalUrl(result.data.portalUrl)
          setExpiresAt(result.data.expiresAt)
          setStatus('ready')
        })
        .catch((err) => {
          console.error('[SendPortalLinkDialog] mint error:', err)
          setStatus('error')
          setErrorMessage('Could not create the link.')
        })
    }
  }, [open, customer.id])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleClose = () => {
    if (status === 'minting' || status === 'sending') return
    onOpenChange(false)
  }

  const handleSendEmail = async () => {
    if (!customer.email) return
    setStatus('sending')
    setErrorMessage('')
    try {
      const result = await sendCustomerPortalLink(customer.id)
      if (!result.success) {
        setStatus('error')
        setErrorMessage(result.error ?? 'Could not send the email.')
        return
      }
      setStatus('sent')
    } catch (err) {
      console.error('[SendPortalLinkDialog] send error:', err)
      setStatus('error')
      setErrorMessage('Could not send the email.')
    }
  }

  const handleCopy = async () => {
    if (!portalUrl) return
    try {
      await navigator.clipboard.writeText(portalUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('[SendPortalLinkDialog] copy error:', err)
      setErrorMessage('Could not copy to clipboard. Select and copy manually.')
      setStatus('error')
    }
  }

  const handleOpen = () => {
    if (!portalUrl) return
    window.open(portalUrl, '_blank', 'noopener,noreferrer')
  }

  if (status === 'sent') {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className='sm:max-w-[420px]'>
          <div className='flex flex-col items-center py-6 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30'>
              <CheckCircle2 className='h-6 w-6 text-emerald-600' />
            </div>
            <h3 className='mt-4 text-lg font-semibold'>Sent</h3>
            <p className='mt-1 text-sm text-muted-foreground'>
              Portal link sent to {customer.email}. It expires in 1 hour and can
              only be opened once.
            </p>
            <Button className='mt-6' onClick={handleClose}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className='grid-cols-1 sm:max-w-[460px]'>
        <DialogHeader>
          <DialogTitle>Send portal link to {customer.name}</DialogTitle>
          <DialogDescription>
            Single-use link, expires in 1 hour. Forwarding it only works for the
            first opener.
          </DialogDescription>
        </DialogHeader>

        {status === 'minting' ? (
          <div className='flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground'>
            <Loader2 className='h-4 w-4 animate-spin' />
            Generating link...
          </div>
        ) : (
          <div className='space-y-3 pt-2'>
            {/* sentry-mask below: this URL carries a live single-use portal
                token, and this dialog renders on the dashboard customers page,
                which session replay records. */}
            {portalUrl && (
              <div className='sentry-mask rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground'>
                <span className='break-all font-mono'>{portalUrl}</span>
                {expiresAt && (
                  <p className='mt-1.5 text-[11px]'>
                    Expires {new Date(expiresAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}

            {customer.email ? (
              <Button
                className='w-full justify-start'
                onClick={handleSendEmail}
                disabled={status === 'sending' || !portalUrl}
              >
                {status === 'sending' ? (
                  <Loader2 className='mr-2 h-4 w-4 flex-shrink-0 animate-spin' />
                ) : (
                  <Mail className='mr-2 h-4 w-4 flex-shrink-0' />
                )}
                <span className='min-w-0 flex-1 truncate text-left'>
                  {status === 'sending'
                    ? 'Sending...'
                    : `Email it to ${customer.email}`}
                </span>
              </Button>
            ) : (
              <p className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800'>
                No email on file for this customer. Add one to enable one-click
                send.
              </p>
            )}

            <Button
              variant='outline'
              className='w-full justify-start'
              onClick={handleCopy}
              disabled={!portalUrl}
            >
              {copied ? (
                <CheckCircle2 className='mr-2 h-4 w-4 text-emerald-600' />
              ) : (
                <Copy className='mr-2 h-4 w-4' />
              )}
              {copied ? 'Copied' : 'Copy URL'}
            </Button>

            <Button
              variant='outline'
              className='w-full justify-start'
              onClick={handleOpen}
              disabled={!portalUrl}
            >
              <ExternalLink className='mr-2 h-4 w-4' />
              Open in new tab
            </Button>

            {status === 'error' && errorMessage && (
              <div className='flex items-start gap-2 text-sm text-destructive'>
                <AlertCircle className='mt-0.5 h-4 w-4 flex-shrink-0' />
                <span>{errorMessage}</span>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
