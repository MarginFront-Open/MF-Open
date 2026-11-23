import { cn } from '@/lib/utils'

interface MainProps {
  fixed?: boolean
  children?: React.ReactNode
  className?: string
}

export const Main = ({ fixed, children, className }: MainProps) => {
  return (
    <main
      className={cn(
        'peer-[.header-fixed]/header:mt-16',
        fixed
          ? 'fixed-main flex flex-grow flex-col overflow-hidden'
          : 'flex-grow overflow-auto',
        className
      )}
    >
      {children}
    </main>
  )
}

Main.displayName = 'Main'
