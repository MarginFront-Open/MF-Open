import { motion } from 'framer-motion'
import { slideInLeft, getAnimationVariants } from '@/lib/animations'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import { NavGroup } from '@/components/layout/nav-group'
import { NavUser } from '@/components/layout/nav-user'
import { TeamSwitcher } from '@/components/layout/team-switcher'
import { sidebarData } from './data/sidebar-data'
import { mergeUnreadBadge } from './data/unread-badge'
import { useUnreadCustomerAlertCount } from '@/services/customer-alerts-service'

interface AppSidebarProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: 'left' | 'right'
  variant?: 'sidebar' | 'floating' | 'inset'
  collapsible?: 'offcanvas' | 'icon' | 'none'
}

export function AppSidebar({ ...props }: AppSidebarProps) {
  const variants = getAnimationVariants(slideInLeft)

  // The MFiQ item carries a red unread customer-alert count. The
  // merge is pure and non-mutating; with zero unread (or a failed poll) the
  // groups are the untouched static singleton.
  const { data: unreadCount } = useUnreadCustomerAlertCount()
  const navGroups = mergeUnreadBadge(sidebarData.navGroups, unreadCount)

  return (
    <motion.div
      initial='initial'
      animate='animate'
      exit='exit'
      variants={variants}
      className='h-full'
    >
      <Sidebar collapsible='icon' variant='floating' {...props}>
        <SidebarHeader className='gap-1 pb-1 pt-1'>
          <TeamSwitcher />
        </SidebarHeader>
        <SidebarContent className='gap-0.5 pt-0'>
          {navGroups.map((props) => (
            <NavGroup key={props.title} {...props} />
          ))}
        </SidebarContent>
        <SidebarFooter className='gap-1 border-t border-sidebar-border p-1'>
          <NavUser />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    </motion.div>
  )
}
