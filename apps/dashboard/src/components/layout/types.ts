interface User {
  name: string
  email: string
  avatar: string
}

interface Team {
  name: string
  logo: React.ElementType
  plan: string
}

interface BaseNavItem {
  title: string
  badge?: string
  // Severity channel for the badge pill. 'destructive' renders
  // Badge's red variant (the unread customer-alert count on MFiQ);
  // unset/'default' keeps the default brand-teal pill.
  badgeVariant?: 'default' | 'destructive'
  icon?: React.ElementType
  disabled?: boolean
  // If set, this item only shows when the current user's role is one of these
  // (compared lower-cased). If not set, no role restriction. This is a
  // VISIBILITY gate only: it hides the nav entry; it does NOT block anyone
  // who types the URL directly. Server-side gates do that.
  requiredRoles?: readonly string[]
  // One-line hover description (native title attribute on the link). NOT a
  // visible second text line: nav density is fixed (13" laptop
  // fit) and the shared tooltip only shows when the sidebar is collapsed.
  description?: string
}

type NavLink = BaseNavItem & {
  url: string
  items?: never
}

type NavCollapsible = BaseNavItem & {
  items: (BaseNavItem & {
    url: string
  })[]
  url?: never
}

type NavItem = NavCollapsible | NavLink

interface NavGroup {
  title: string
  items: NavItem[]
}

interface SidebarData {
  user: User
  teams: Team[]
  navGroups: NavGroup[]
}

export type { SidebarData, NavGroup, NavItem, NavCollapsible, NavLink }
