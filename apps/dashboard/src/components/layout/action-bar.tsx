import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface ActionBarProps {
  children: React.ReactNode
  className?: string
}

export function ActionBar({ children, className }: ActionBarProps) {
  const [isSticky, setIsSticky] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      // Make sticky after scrolling past 56px (header height)
      setIsSticky(window.scrollY > 56)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <div
      className={cn(
        'h-15 flex items-center justify-end gap-3 border-b border-border/40 bg-background/95 px-6 py-3 backdrop-blur-sm transition-all duration-200',
        isSticky && 'sticky top-14 z-40 shadow-sm',
        className
      )}
    >
      {children}
    </div>
  )
}
