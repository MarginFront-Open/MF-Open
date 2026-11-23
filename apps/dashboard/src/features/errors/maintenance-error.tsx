'use client'

import { Button } from '@/components/ui/button'

export default function MaintenanceError() {
  return (
    <div className='h-svh'>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='font-heading text-display font-bold text-primary'>
          503
        </h1>
        <h2 className='font-medium text-foreground'>
          Website is under maintenance!
        </h2>
        <p className='text-center text-sm text-muted-foreground'>
          The site is not available at the moment. <br />
          We&apos;ll be back online shortly.
        </p>
        <div className='mt-6 flex gap-4'>
          <Button variant='outline'>Learn more</Button>
        </div>
      </div>
    </div>
  )
}
