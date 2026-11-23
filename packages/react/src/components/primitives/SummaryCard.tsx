'use client';

/**
 * SummaryCard Component
 * Elegant stat card with label and value - used in summary rows
 * Design: Soft backgrounds with subtle visual hierarchy
 */

import { cn } from '../../utils/cn';

export interface SummaryCardProps {
  /** Card label */
  label: string;
  /** Main value (formatted string) */
  value: string;
  /** Optional sublabel */
  sublabel?: string;
  /** Value color (for highlighting) */
  valueColor?: string;
  /** Icon to display (optional) */
  icon?: React.ReactNode;
  /** Custom class name */
  className?: string;
}

export function SummaryCard({
  label,
  value,
  sublabel,
  valueColor,
  icon,
  className,
}: SummaryCardProps) {
  return (
    <div
      className={cn(
        'marginfront-summary-card relative overflow-hidden',
        'bg-gradient-to-br from-gray-50 to-gray-50/50',
        'border border-gray-100/80 rounded-xl px-4 py-4',
        'transition-all duration-200 hover:border-gray-200/80 hover:shadow-sm',
        className
      )}
    >
      {/* Subtle top accent line */}
      {valueColor && (
        <div
          className="absolute top-0 left-4 right-4 h-0.5 rounded-full opacity-60"
          style={{ backgroundColor: valueColor }}
        />
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
            {label}
          </div>
          <div
            className="text-xl font-bold text-gray-900 tracking-tight truncate"
            style={valueColor ? { color: valueColor } : undefined}
          >
            {value}
          </div>
          {sublabel && (
            <div className="text-xs text-gray-400 mt-1">{sublabel}</div>
          )}
        </div>

        {icon && (
          <div className="flex-shrink-0 text-gray-300">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
