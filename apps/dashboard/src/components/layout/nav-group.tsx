'use client'

import { ReactNode, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Badge } from '../ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { NavCollapsible, NavItem, NavLink, type NavGroup } from './types'
import { useAuth } from '@/hooks/use-auth'
import { getVisibleNavItems, resolveCurrentUserRole } from './nav-visibility'

export function NavGroup({ title, items }: NavGroup) {
  const { state } = useSidebar()
  const href = usePathname()
  // The sidebar depends on the VIEWER's role — finance/
  // admin/owner see the FinOps section; it's hidden from plain members.
  //
  // Resolve the role from the logged-in user's OWN org
  // membership — NOT useAuth().user.role. That field is computed app-wide as
  // activeOrg.members[0].role (the org's first member = creator/owner), so
  // using it here would give a finance teammate the owner's view and let a
  // plain member wrongly clear the FinOps gate. So this looks the viewer up
  // by session user id. Falls back to 'member' (least privilege) while the
  // session/membership loads.
  const { session, activeOrganization } = useAuth()
  const role = resolveCurrentUserRole(
    activeOrganization?.members,
    session?.user?.id
  )

  // The role visibility rules live in nav-visibility.ts (a pure,
  // unit-tested function). Keeping them there — instead of inline here — is what
  // lets the Node-only jest harness test them without rendering this component.
  const visibleItems = useMemo(
    () => getVisibleNavItems(items, role),
    [items, role]
  )

  if (visibleItems.length === 0) return null

  // The sidebar nav is dense enough that EVERY destination fits on a 13"
  // laptop (1440x790 usable height, after the browser's own toolbar) without
  // scrolling: py-1 rows, h-5 group labels, py-0 group shells and the base
  // gap-1 between rows. All of it is scoped to the sidebar nav, never the
  // shared ui/sidebar.tsx primitive, so settings sub-nav / header / switchers
  // don't shift. Every item renders; SidebarContent keeps overflow-auto so
  // windows shorter than a laptop still scroll.
  return (
    // gap-0.5 in SidebarContent (app-sidebar.tsx) provides the visual
    // separation between groups.
    <SidebarGroup className='px-2 py-0'>
      {/* h-5 gives each label enough visual height so sections read
          clearly. */}
      <SidebarGroupLabel className='mb-0 h-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70'>
        {title}
      </SidebarGroupLabel>
      <SidebarMenu>
        {visibleItems.map((item) => {
          const key = `${item.title}-${item.url}`

          if (!item.items)
            return <SidebarMenuLink key={key} item={item} href={href} />

          if (state === 'collapsed')
            return (
              <SidebarMenuCollapsedDropdown key={key} item={item} href={href} />
            )

          return <SidebarMenuCollapsible key={key} item={item} href={href} />
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

// Variant passthrough so a live count can render red
// (Badge's 'destructive' variant) while every other badge keeps the default
// brand pill.
const NavBadge = ({
  children,
  variant,
}: {
  children: ReactNode
  variant?: 'default' | 'destructive'
}) => (
  <Badge
    variant={variant ?? 'default'}
    className='rounded-full px-1 py-0 text-xs'
  >
    {children}
  </Badge>
)

const SidebarMenuLink = ({ item, href }: { item: NavLink; href: string }) => {
  const { setOpenMobile } = useSidebar()
  const linkHref = typeof item.url === 'string' ? item.url : '#'
  const isExternal = linkHref.startsWith('http')

  if (item.disabled) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={false}
          tooltip={item.title}
          // Py-1 makes each row ~28px (vs the shared py-2.5
          // default's ~40px). Note the icon (size-5, 20px) and the text line
          // (~20px) tie for the row's content height, so shrinking the icon
          // would buy nothing — the padding is the only real lever here. Scoped
          // at the call site so the settings sub-nav, header, and switchers
          // that share this primitive are untouched.
          className='cursor-not-allowed py-1 opacity-40'
        >
          {item.icon && <item.icon />}
          <span>{item.title}</span>
          {item.badge && (
            <NavBadge variant={item.badgeVariant}>{item.badge}</NavBadge>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={checkIsActive(href, item)}
        tooltip={item.title}
        // Py-1 (vs the shared py-2.5 default) makes each nav
        // row ~28px. Scoped to the nav link so shared consumers don't shift.
        className='py-1'
      >
        <Link
          href={linkHref}
          onClick={() => setOpenMobile(false)}
          title={item.description}
          {...(isExternal
            ? { target: '_blank', rel: 'noopener noreferrer' }
            : {})}
        >
          {item.icon && <item.icon />}
          <span>{item.title}</span>
          {item.badge && (
            <NavBadge variant={item.badgeVariant}>{item.badge}</NavBadge>
          )}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

const SidebarMenuCollapsible = ({
  item,
  href,
}: {
  item: NavCollapsible
  href: string
}) => {
  const { setOpenMobile } = useSidebar()
  return (
    <Collapsible
      asChild
      defaultOpen={checkIsActive(href, item, true)}
      className='group/collapsible'
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title}>
            {item.icon && <item.icon />}
            <span>{item.title}</span>
            {item.badge && (
              <NavBadge variant={item.badgeVariant}>{item.badge}</NavBadge>
            )}
            <ChevronRight className='ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90' />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className='CollapsibleContent'>
          <SidebarMenuSub>
            {item.items.map((subItem) => {
              const subLinkHref =
                typeof subItem.url === 'string' ? subItem.url : '#'
              return (
                <SidebarMenuSubItem key={subItem.title}>
                  <SidebarMenuSubButton
                    asChild
                    isActive={checkIsActive(href, subItem)}
                  >
                    <Link
                      href={subLinkHref}
                      onClick={() => setOpenMobile(false)}
                    >
                      {subItem.icon && <subItem.icon />}
                      <span>{subItem.title}</span>
                      {subItem.badge && (
                        <NavBadge variant={subItem.badgeVariant}>
                          {subItem.badge}
                        </NavBadge>
                      )}
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

const SidebarMenuCollapsedDropdown = ({
  item,
  href,
}: {
  item: NavCollapsible
  href: string
}) => {
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={item.title}
            isActive={checkIsActive(href, item)}
          >
            {item.icon && <item.icon />}
            <span>{item.title}</span>
            {item.badge && (
              <NavBadge variant={item.badgeVariant}>{item.badge}</NavBadge>
            )}
            <ChevronRight className='ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90' />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side='right' align='start' sideOffset={4}>
          <DropdownMenuLabel>
            {item.title} {item.badge ? `(${item.badge})` : ''}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {item.items.map((sub) => {
            const dropdownLinkHref = typeof sub.url === 'string' ? sub.url : '#'
            return (
              <DropdownMenuItem key={`${sub.title}-${sub.url}`} asChild>
                <Link
                  href={dropdownLinkHref}
                  className={`${checkIsActive(href, sub) ? 'bg-secondary' : ''}`}
                >
                  {sub.icon && <sub.icon />}
                  <span className='max-w-52 text-wrap'>{sub.title}</span>
                  {sub.badge && (
                    <span className='ml-auto text-xs'>{sub.badge}</span>
                  )}
                </Link>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

function checkIsActive(href: string, item: NavItem, mainNav = false) {
  return (
    href === item.url || // /endpoint?search=param
    href.split('?')[0] === item.url || // /endpoint
    !!item?.items?.filter((i) => i.url === href).length || // if child nav is active
    (mainNav &&
      href.split('/')[1] !== '' &&
      href.split('/')[1] === item?.url?.split('/')[1])
  )
}
