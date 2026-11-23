import {
  Desktop,
  FileText,
  CurrencyDollar,
  Bank,
  Code,
  ChartLineUp,
  Brain,
  Robot,
  Scales,
} from '@phosphor-icons/react'
import { Command } from 'lucide-react'
import { docsLink } from '@/config/operator'

const OPERATOR_DOCS_URL = docsLink()

// NavUser reads the real signed-in identity from useAuth(); there is no
// static fallback identity here. NavUser renders a loading skeleton until
// the session resolves.
export const sidebarData = {
  teams: [
    {
      name: 'MarginFront',
      logo: Command,
      plan: 'Master your pricing model.',
    },
  ],
  navGroups: [
    // ---------- COMMAND CENTER ----------
    // The five command-center pages. Gating mirrors each route's own guard so the nav
    // never promises a page the route 403s: Money/FinOps/ROI/MF IQ =
    // requireRouteRoles(MANAGE_MONEY_ROLES); Build is ungated by design.
    // Other routes stay reachable by URL but aren't listed here.
    {
      title: 'Command Center',
      items: [
        {
          title: 'Unit Economics',
          url: '/money',
          icon: CurrencyDollar,
          description: 'Includes Invoices and Overdue',
          requiredRoles: ['finance', 'admin', 'owner'] as const,
        },
        {
          title: 'AI Accounting',
          url: '/finops',
          icon: Bank,
          requiredRoles: ['finance', 'admin', 'owner'] as const,
        },
        {
          title: 'Internal AI Spend',
          url: '/internal-ai-spend',
          icon: Robot,
          requiredRoles: ['finance', 'admin', 'owner'] as const,
        },
        {
          title: 'Build',
          url: '/build',
          icon: Code,
        },
        {
          title: 'ROI',
          url: '/roi',
          icon: ChartLineUp,
          requiredRoles: ['finance', 'admin', 'owner'] as const,
        },
        {
          title: 'MFiQ',
          url: '/mfiq',
          icon: Brain,
          requiredRoles: ['finance', 'admin', 'owner'] as const,
        },
        {
          title: 'Matters',
          url: '/law',
          icon: Scales,
          description: 'Cost per matter, the job AI work is billed against',
          // 'legal' clears no OTHER requiredRoles gate, but like member it still
          // sees every gate-less entry. The route guard in
          // app/(dashboard)/law/page.tsx enforces the same set.
          requiredRoles: ['finance', 'admin', 'owner', 'legal'] as const,
        },
      ],
    },

    // ---------- LEARN ----------
    // Onboarding + docs, visible to everyone. Documentation is the operator's
    // docs site and only shows when NEXT_PUBLIC_DOCS_URL is set. API Keys and
    // the SDK Simulator live on the Build command-center page. The group is
    // called Learn so it doesn't collide with the Command Center's Build page.
    {
      title: 'Learn',
      items: [
        {
          title: 'Getting Started',
          url: '/developer-zone/getting-started',
          icon: Desktop,
        },
        ...(OPERATOR_DOCS_URL
          ? [
              {
                title: 'Documentation',
                url: OPERATOR_DOCS_URL,
                icon: FileText,
              },
            ]
          : []),
      ],
    },
  ],
}
