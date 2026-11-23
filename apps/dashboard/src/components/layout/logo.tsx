'use client'

import * as React from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

interface LogoProps extends React.HTMLAttributes<HTMLDivElement> {
  linkToHome?: boolean
  className?: string
  size?: 'sm' | 'default' | 'lg'
  forceWhite?: boolean
}

export const Logo = React.forwardRef<HTMLDivElement, LogoProps>(
  (
    {
      linkToHome = true,
      className,
      size = 'default',
      forceWhite: _forceWhite,
      ...props
    },
    ref
  ) => {
    const sizeMap = {
      sm: 24,
      default: 32,
      lg: 64,
    }

    const height = sizeMap[size]

    const logoContent = (
      <div ref={ref} className={cn('flex items-center', className)} {...props}>
        <img
          src='/marginfront-logo-green.jpg'
          alt='MarginFront Logo'
          height={height}
          className='w-auto rounded transition-opacity duration-200'
          style={{ height: `${height}px` }}
        />
      </div>
    )

    if (linkToHome) {
      return (
        <Link
          href='/'
          className='flex items-center transition-opacity hover:opacity-80'
        >
          {logoContent}
        </Link>
      )
    }

    return logoContent
  }
)

Logo.displayName = 'Logo'
