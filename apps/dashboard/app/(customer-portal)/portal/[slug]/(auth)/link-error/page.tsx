import { db as prisma } from '@/app/lib/db'
import { AlertCircle, Clock, RefreshCw } from 'lucide-react'

interface LinkErrorPageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ reason?: string }>
}

const REASONS: Record<
  string,
  { title: string; body: string; icon: 'expired' | 'used' | 'invalid' }
> = {
  link_expired: {
    title: 'This link has expired',
    body: 'Portal links last for 1 hour. Ask {{org}} to send you a fresh one.',
    icon: 'expired',
  },
  link_already_used: {
    title: 'This link was already opened',
    body: 'Each link only works once. Ask {{org}} to send you a fresh one if you need to view your portal again.',
    icon: 'used',
  },
  invalid_link: {
    title: "This link isn't valid",
    body: 'Double-check that you copied the whole URL, or ask {{org}} to send you a fresh one.',
    icon: 'invalid',
  },
  rate_limited: {
    title: 'Too many attempts',
    body: 'Wait a minute and try again, or ask {{org}} to send you a fresh link.',
    icon: 'used',
  },
  server_error: {
    title: 'Something went wrong on our end',
    body: 'Try the link again in a moment. If it keeps failing, ask {{org}} to send you a new one.',
    icon: 'invalid',
  },
}

const ICONS = {
  expired: Clock,
  used: RefreshCw,
  invalid: AlertCircle,
}

export default async function PortalLinkErrorPage({
  params,
  searchParams,
}: LinkErrorPageProps) {
  const { slug } = await params
  const { reason: rawReason } = await searchParams
  const reasonKey = rawReason && REASONS[rawReason] ? rawReason : 'invalid_link'
  const reason = REASONS[reasonKey]

  // Look up the org from the slug in the URL path so the page can show the
  // customer who sent the link.
  const organization = await prisma.organizations.findFirst({
    where: { slug },
    select: { name: true },
  })
  const orgName = organization?.name ?? 'the company that sent it'

  const Icon = ICONS[reason.icon]
  const body = reason.body.replace('{{org}}', orgName)
  const currentYear = new Date().getFullYear()

  return (
    <div className='flex min-h-screen flex-col bg-background'>
      <main className='flex flex-1 items-center justify-center px-4 py-12'>
        <div className='w-full max-w-md text-center'>
          <div className='mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-[#003024]/10'>
            <Icon className='h-7 w-7 text-[#003024]' />
          </div>
          <h1 className='text-2xl font-semibold tracking-tight text-foreground'>
            {reason.title}
          </h1>
          <p className='mt-3 text-sm leading-relaxed text-muted-foreground'>
            {body}
          </p>
        </div>
      </main>

      <footer className='border-t border-border bg-card/40'>
        <div className='mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row'>
          <span>
            © {currentYear} {orgName}
          </span>
          <span>
            Powered by{' '}
            <span className='font-medium text-foreground'>MarginFront</span>
          </span>
        </div>
      </footer>
    </div>
  )
}
