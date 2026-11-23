import { useState } from 'react'
import { Copy, Check, FileCode, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'

interface CodeBlockProps {
  code: string
  language?: string
  filename?: string
  showLineNumbers?: boolean
  className?: string
}

export const CodeBlock = ({
  code,
  language = 'bash',
  filename,
  showLineNumbers = false,
  className,
}: CodeBlockProps) => {
  const [copied, setCopied] = useState(false)
  const { toast } = useToast()

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    toast({ title: 'Copied!' })
    setTimeout(() => setCopied(false), 2000)
  }

  const isTerminal = language === 'bash' || language === 'shell'

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-border',
        className
      )}
    >
      {/* Header with filename */}
      {filename && (
        <div className='flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2'>
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            {isTerminal ? (
              <Terminal className='h-4 w-4' />
            ) : (
              <FileCode className='h-4 w-4' />
            )}
            <span className='font-mono'>{filename}</span>
          </div>
          <button
            onClick={handleCopy}
            className='flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
          >
            {copied ? (
              <>
                <Check className='h-3.5 w-3.5 text-theme-accent-500' />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className='h-3.5 w-3.5' />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Code content */}
      <div className='relative bg-zinc-950 text-zinc-100'>
        {!filename && (
          <button
            onClick={handleCopy}
            className='absolute right-3 top-3 rounded-md p-2 transition-colors hover:bg-white/10'
          >
            {copied ? (
              <Check className='h-4 w-4 text-theme-accent-500' />
            ) : (
              <Copy className='h-4 w-4 text-zinc-400' />
            )}
          </button>
        )}
        <pre
          className={cn(
            'overflow-x-auto p-4 font-mono text-sm',
            !filename && 'pr-12'
          )}
        >
          {showLineNumbers ? (
            <code>
              {code.split('\n').map((line, i) => (
                <div key={i} className='flex'>
                  <span className='mr-4 w-8 select-none text-right text-zinc-600'>
                    {i + 1}
                  </span>
                  <span>{line}</span>
                </div>
              ))}
            </code>
          ) : (
            <code>{code}</code>
          )}
        </pre>
      </div>
    </div>
  )
}

// Simplified inline code block for environment variables
interface EnvBlockProps {
  variables: { key: string; value: string; masked?: boolean }[]
  className?: string
}

export const EnvBlock = ({ variables, className }: EnvBlockProps) => {
  const [copied, setCopied] = useState(false)
  const { toast } = useToast()

  const envString = variables.map((v) => `${v.key}="${v.value}"`).join('\n')

  const handleCopy = async () => {
    await navigator.clipboard.writeText(envString)
    setCopied(true)
    toast({ title: 'Copied!' })
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border',
        className
      )}
    >
      {/* Header */}
      <div className='flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2'>
        <div className='flex items-center gap-2 text-sm text-muted-foreground'>
          <FileCode className='h-4 w-4' />
          <span className='font-mono'>.env</span>
        </div>
        <button
          onClick={handleCopy}
          className='flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
        >
          {copied ? (
            <>
              <Check className='h-3.5 w-3.5 text-theme-accent-500' />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className='h-3.5 w-3.5' />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Content */}
      <div className='bg-zinc-950 p-4 text-zinc-100'>
        <pre className='font-mono text-sm'>
          {variables.map((v, i) => (
            <div key={i}>
              <span className='text-purple-400'>{v.key}</span>
              <span className='text-zinc-500'>=</span>
              <span className='text-theme-accent-400'>
                &quot;
                {v.masked
                  ? '•'.repeat(Math.min(v.value.length, 20)) + '...'
                  : v.value}
                &quot;
              </span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}
