'use client'

import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface GeneralErrorProps extends React.HTMLAttributes<HTMLDivElement> {
  minimal?: boolean
}

export default function GeneralError({
  className,
  minimal = false,
}: GeneralErrorProps) {
  const router = useRouter()
  return (
    <div className={cn('h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        {!minimal && (
          <h1 className='font-heading text-display font-bold text-primary'>
            500
          </h1>
        )}
        <h2 className='font-medium text-foreground'>
          Oops! Something went wrong {`:')`}
        </h2>
        <p className='text-center text-sm text-muted-foreground'>
          We apologize for the inconvenience. <br /> Please try again later.
        </p>
        {!minimal && (
          <div className='mt-6 flex gap-4'>
            <Button variant='outline' onClick={() => router.back()}>
              Go Back
            </Button>
            <Button onClick={() => router.push('/')}>Back to Home</Button>
          </div>
        )}
      </div>
    </div>
  )
}
