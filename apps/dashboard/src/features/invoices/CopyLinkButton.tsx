/**
 * Copy Link Button Component
 *
 * Copies the public invoice URL to clipboard.
 * URL format: /i/{invoiceId}
 */
import { useState } from 'react'
import { Link2, Check, Copy } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { Button, ButtonProps } from '@/components/ui/button'

interface CopyLinkButtonProps extends Omit<ButtonProps, 'onClick' | 'variant'> {
  /**
   * Invoice ID to generate the public URL
   */
  invoiceId: string

  /**
   * Display mode
   * - 'button': Full button with text
   * - 'icon': Icon-only button
   */
  displayMode?: 'button' | 'icon'

  /**
   * Button style variant (from shadcn)
   */
  variant?: ButtonProps['variant']
}

/**
 * Copy text to clipboard with fallback for older browsers
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }

    // Fallback for older browsers
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    return success
  } catch {
    return false
  }
}

export function CopyLinkButton({
  invoiceId,
  displayMode = 'button',
  variant = 'outline',
  size = 'sm',
  className,
  ...buttonProps
}: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    // Links go straight to checkout via `/i/{id}/pay` (route handler that
    // 302s to Stripe).
    const url = `${window.location.origin}/i/${invoiceId}/pay`
    const success = await copyToClipboard(url)

    if (success) {
      setCopied(true)
      toast.success('Link copied to clipboard')

      // Reset after 2 seconds
      setTimeout(() => setCopied(false), 2000)
    } else {
      toast.error({
        title: 'Failed to copy',
        description: 'Please copy the URL manually.',
      })
    }
  }

  const Icon = copied ? Check : displayMode === 'icon' ? Copy : Link2

  if (displayMode === 'icon') {
    return (
      <Button
        variant={variant}
        size='icon'
        onClick={handleCopy}
        className={className}
        title='Copy public link'
        {...buttonProps}
      >
        <Icon className={`h-4 w-4 ${copied ? 'text-secondary-dark' : ''}`} />
      </Button>
    )
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleCopy}
      className={className}
      {...buttonProps}
    >
      <Icon className={`mr-2 h-4 w-4 ${copied ? 'text-secondary-dark' : ''}`} />
      {copied ? 'Copied!' : 'Copy Link'}
    </Button>
  )
}
