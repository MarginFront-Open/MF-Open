import { cn } from '@/lib/utils'
import { Logo } from '@/components/layout/logo'
import { ThemeSwitch } from '@/components/theme-switch'
import { copyrightLine } from '@/config/operator'

interface PremiumAuthLayoutProps {
  children: React.ReactNode
  className?: string
  maxWidth?: string
  centerContent?: boolean
}

export function PremiumAuthLayout({
  children,
  className,
  maxWidth = 'max-w-[480px]',
  centerContent = true,
}: PremiumAuthLayoutProps) {
  return (
    <div className='min-h-screen w-full lg:grid lg:grid-cols-[40%_60%]'>
      {/* Left Sidebar - Green Branded Panel with white space border */}
      <div className='relative hidden h-screen bg-background p-3 lg:flex'>
        <div className='relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-theme-primary'>
          {/* Decorative elements */}
          <div className='to-theme-primary-dark absolute inset-0 rounded-2xl bg-gradient-to-br from-theme-primary/90 via-theme-primary opacity-80' />
          <div className='bg-theme-accent/8 absolute right-0 top-0 h-[500px] w-[500px] -translate-y-1/3 translate-x-1/3 rounded-full blur-[100px]' />
          <div className='absolute bottom-0 left-0 h-[300px] w-[300px] -translate-x-1/3 translate-y-1/3 rounded-full bg-theme-accent/5 blur-[80px]' />

          {/* Subtle dot pattern */}
          <div
            className='absolute inset-0 opacity-[0.12]'
            style={{
              backgroundImage: `radial-gradient(circle at 1px 1px, hsl(var(--secondary) / 0.3) 1px, transparent 0)`,
              backgroundSize: '32px 32px',
            }}
          />

          {/* Content Container */}
          <div className='relative z-10 flex h-full flex-col justify-between p-8 xl:p-10'>
            {/* Logo - Top */}
            <div className='flex items-center justify-between'>
              <Logo
                linkToHome={false}
                size='lg'
                className='text-white'
                forceWhite
              />
              <ThemeSwitch />
            </div>

            {/* Main Content - Centered */}
            <div className='max-w-md space-y-5'>
              <div className='space-y-2'>
                <h1 className='text-4xl font-bold leading-[1.1] tracking-tight text-white xl:text-5xl'>
                  Scale Your
                  <br />
                  <span className='text-theme-accent'>AI Revenue</span>
                </h1>
                <p className='text-sm leading-relaxed text-white/60'>
                  Powering the next generation of AI-first businesses with
                  intelligent billing.
                </p>
              </div>

              {/* Feature Cards - 2x2 Grid */}
              <div className='grid grid-cols-2 gap-2.5'>
                <div className='rounded-xl border border-white/[0.08] bg-white/[0.06] p-3'>
                  <div className='flex items-start gap-2.5'>
                    <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-theme-accent/20'>
                      <svg
                        className='h-4 w-4 text-theme-accent'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M13 7h8m0 0v8m0-8l-8 8-4-4-6 6'
                        />
                      </svg>
                    </div>
                    <div>
                      <h3 className='text-sm font-semibold text-white'>
                        Usage-Based Pricing
                      </h3>
                      <p className='mt-0.5 text-[11px] text-white/60'>
                        Charge based on actual AI usage.
                      </p>
                    </div>
                  </div>
                </div>

                <div className='rounded-xl border border-white/[0.08] bg-white/[0.06] p-3'>
                  <div className='flex items-start gap-2.5'>
                    <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-theme-accent/20'>
                      <svg
                        className='h-4 w-4 text-theme-accent'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'
                        />
                      </svg>
                    </div>
                    <div>
                      <h3 className='text-sm font-semibold text-white'>
                        Real-Time Analytics
                      </h3>
                      <p className='mt-0.5 text-[11px] text-white/60'>
                        Track costs and revenue live.
                      </p>
                    </div>
                  </div>
                </div>

                <div className='rounded-xl border border-white/[0.08] bg-white/[0.06] p-3'>
                  <div className='flex items-start gap-2.5'>
                    <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-theme-accent/20'>
                      <svg
                        className='h-4 w-4 text-theme-accent'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'
                        />
                      </svg>
                    </div>
                    <div>
                      <h3 className='text-sm font-semibold text-white'>
                        Enterprise Security
                      </h3>
                      <p className='mt-0.5 text-[11px] text-white/60'>
                        Encrypted & secure.
                      </p>
                    </div>
                  </div>
                </div>

                <div className='rounded-xl border border-white/[0.08] bg-white/[0.06] p-3'>
                  <div className='flex items-start gap-2.5'>
                    <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-theme-accent/20'>
                      <svg
                        className='h-4 w-4 text-theme-accent'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
                        />
                      </svg>
                    </div>
                    <div>
                      <h3 className='text-sm font-semibold text-white'>
                        Margin Optimization
                      </h3>
                      <p className='mt-0.5 text-[11px] text-white/60'>
                        Maximize your AI profits.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Bullet Points */}
              <div className='flex items-center gap-4 pt-1'>
                {[
                  'Usage-based pricing',
                  'Real-time analytics',
                  'Enterprise security',
                ].map((feature) => (
                  <div key={feature} className='flex items-center gap-1.5'>
                    <div className='flex h-4 w-4 items-center justify-center rounded-full bg-theme-accent'>
                      <svg
                        className='h-2.5 w-2.5 text-theme-primary'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M5 13l4 4L19 7'
                        />
                      </svg>
                    </div>
                    <span className='text-[11px] text-white/70'>{feature}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer - Bottom */}
            <p className='text-xs text-white/35'>{copyrightLine()}</p>
          </div>
        </div>
      </div>

      {/* Right Content - Form Area */}
      <div
        className={cn(
          'relative flex h-screen flex-col overflow-y-auto bg-background p-4 lg:p-8',
          className
        )}
      >
        {/* Mobile Logo */}
        <div className='absolute left-4 top-4 lg:hidden'>
          <Logo linkToHome={false} size='default' />
        </div>

        {/* Theme Toggle - Mobile Only (Top Right) */}
        <div className='absolute right-4 top-4 z-50 lg:hidden'>
          <ThemeSwitch />
        </div>

        {/* Main Content */}
        <div
          className={cn(
            'mx-auto w-full',
            centerContent ? 'my-auto' : 'h-full',
            maxWidth
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
