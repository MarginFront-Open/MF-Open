'use client';

import { createContext, useContext } from 'react';

export interface BrandColors {
  primary: string;
  secondary: string;
  accent: string;
}

export interface OrgContextValue {
  organizationName: string;
  organizationSlug: string;
  organizationLogo: string | null;
  brandColors: BrandColors;
  /** Whether this session was created via admin impersonation */
  isImpersonated: boolean;
  /** The admin user name who is impersonating (if applicable) */
  impersonatedByUserName: string | null;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: OrgContextValue;
}) {
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg() {
  const context = useContext(OrgContext);
  if (!context) {
    throw new Error('useOrg must be used within an OrgProvider');
  }
  return context;
}
