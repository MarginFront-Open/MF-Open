'use client';

/**
 * ComponentHeader Component
 * Refined header with logo, title badge, and customize button
 * Design: Clean with subtle depth and refined typography
 */

import { cn } from '../../utils/cn';
import { useMarginFrontContext } from '../../context';

export interface ComponentHeaderProps {
  /** Company/product name */
  companyName?: string;
  /** Logo URL or React node */
  logo?: string | React.ReactNode;
  /** Component type label (shown in badge) */
  componentLabel: string;
  /** Show customize button */
  showCustomize?: boolean;
  /** Customize click handler */
  onCustomize?: () => void;
  /** Brand color override */
  brandColor?: string;
  /** Custom class name */
  className?: string;
}

export function ComponentHeader({
  companyName = 'Your Product',
  logo,
  componentLabel,
  showCustomize = false,
  onCustomize,
  brandColor,
  className,
}: ComponentHeaderProps) {
  const { theme } = useMarginFrontContext();
  const primaryColor = brandColor || theme.primary || '#047857';

  return (
    <div
      className={cn(
        'marginfront-component-header',
        'flex items-center justify-between px-6 py-4',
        'border-b border-gray-100/80 bg-gradient-to-r from-gray-50/50 to-transparent',
        className
      )}
    >
      {/* Left: Logo + Company Name */}
      <div className="flex items-center gap-3">
        {logo ? (
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center overflow-hidden shadow-sm"
            style={{ backgroundColor: `${primaryColor}10` }}
          >
            {typeof logo === 'string' ? (
              <img src={logo} alt={companyName} className="w-full h-full object-cover" />
            ) : (
              <span style={{ color: primaryColor }}>{logo}</span>
            )}
          </div>
        ) : (
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm"
            style={{ backgroundColor: `${primaryColor}12` }}
          >
            <span className="text-sm font-bold" style={{ color: primaryColor }}>
              {companyName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <span className="font-semibold text-gray-900 tracking-tight">{companyName}</span>
      </div>

      {/* Center: Component Label Badge */}
      <div
        className="px-3.5 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wide border"
        style={{
          color: primaryColor,
          borderColor: `${primaryColor}25`,
          backgroundColor: `${primaryColor}08`,
        }}
      >
        {componentLabel}
      </div>

      {/* Right: Customize Button */}
      {showCustomize ? (
        <button
          onClick={onCustomize}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium text-gray-600
                     border border-gray-200 bg-white shadow-sm
                     hover:bg-gray-50 hover:border-gray-300 hover:text-gray-900
                     transition-all duration-200"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Customize
        </button>
      ) : (
        /* Spacer to maintain layout when no customize button */
        <div className="w-24" />
      )}
    </div>
  );
}
