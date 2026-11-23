'use client'

import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export default function UnauthorisedError() {
  const router = useRouter()
  return (
    <div className='h-svh'>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='font-heading text-display font-bold text-primary'>
          401
        </h1>
        <h2 className='font-medium text-foreground'>Unauthorized Access</h2>
        <p className='text-center text-sm text-muted-foreground'>
          Please log in with the appropriate credentials <br /> to access this
          resource.
        </p>
        <div className='mt-6 flex gap-4'>
          <Button variant='outline' onClick={() => router.back()}>
            Go Back
          </Button>
          <Button onClick={() => router.push('/')}>Back to Home</Button>
        </div>
      </div>
    </div>
  )
}
