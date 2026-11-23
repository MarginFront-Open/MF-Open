'use client';

/**
 * MetricCard Component
 * Sleek stat card with icon, value, trend indicator, and optional sparkline
 * Design: Refined glassmorphism-inspired with subtle depth
 */

import { useMemo } from 'react';
import { useMarginFrontContext } from '../../context';
import { cn } from '../../utils/cn';

export interface MetricCardProps {
  /** Icon component or emoji */
  icon?: React.ReactNode;
  /** Main metric label */
  label: string;
  /** Metric value (formatted string) */
  value: string;
  /** Trend percentage (e.g., "+12%" or "-8%") */
  trend?: string;
  /** Trend direction */
  trendDirection?: 'up' | 'down' | 'neutral';
  /** Sparkline data points (0-100 normalized) */
  sparkline?: number[];
  /** Brand color override */
  brandColor?: string;
  /** Custom class name */
  className?: string;
  /** Click handler */
  onClick?: () => void;
}

export function MetricCard({
  icon,
  label,
  value,
  trend,
  trendDirection,
  sparkline,
  brandColor,
  className,
  onClick,
}: MetricCardProps) {
  const { theme } = useMarginFrontContext();
  const primaryColor = brandColor || theme.primary || '#047857';

  // Auto-detect trend direction from trend string
  const direction = useMemo(() => {
    if (trendDirection) return trendDirection;
    if (!trend) return 'neutral';
    if (trend.startsWith('+') || trend.startsWith('↑')) return 'up';
    if (trend.startsWith('-') || trend.startsWith('↓')) return 'down';
    return 'neutral';
  }, [trend, trendDirection]);

  const trendColor = direction === 'up' ? '#10b981' : direction === 'down' ? '#ef4444' : '#6b7280';

  // Generate sparkline path
  const sparklinePath = useMemo(() => {
    if (!sparkline || sparkline.length < 2) return null;
    const width = 64;
    const height = 28;
    const points = sparkline.map((v, i) => ({
      x: (i / (sparkline.length - 1)) * width,
      y: height - (v / 100) * (height - 4) - 2, // Add padding
    }));
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  }, [sparkline]);

  return (
    <div
      onClick={onClick}
      className={cn(
        'marginfront-metric-card group relative',
        'bg-white rounded-2xl p-5 transition-all duration-300',
        'border border-gray-100 shadow-sm',
        'hover:shadow-md hover:border-gray-200/80 hover:-translate-y-0.5',
        onClick && 'cursor-pointer',
        className
      )}
    >
      {/* Subtle gradient overlay for depth */}
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-gray-50/50 to-transparent pointer-events-none" />

      <div className="relative">
        {/* Header Row: Icon + Trend */}
        <div className="flex items-center justify-between mb-4">
          {/* Icon */}
          {icon && (
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-105"
              style={{ backgroundColor: `${primaryColor}12` }}
            >
              {typeof icon === 'string' ? (
                <span className="text-lg">{icon}</span>
              ) : (
                <span style={{ color: primaryColor }} className="[&>svg]:w-5 [&>svg]:h-5">{icon}</span>
              )}
            </div>
          )}

          {/* Trend Badge */}
          {trend && (
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold"
              style={{
                backgroundColor: `${trendColor}12`,
                color: trendColor,
              }}
            >
              <svg
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {direction === 'up' ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                ) : direction === 'down' ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14" />
                )}
              </svg>
              {trend}
            </div>
          )}
        </div>

        {/* Value + Sparkline Row */}
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-2xl font-bold text-gray-900 tracking-tight">{value}</div>
            <div className="text-sm text-gray-500 mt-1 truncate">{label}</div>
          </div>

          {/* Sparkline */}
          {sparklinePath && (
            <svg width="64" height="28" className="flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
              {/* Gradient fill under the line */}
              <defs>
                <linearGradient id={`sparkline-gradient-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={direction === 'down' ? '#ef4444' : primaryColor} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={direction === 'down' ? '#ef4444' : primaryColor} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d={`${sparklinePath} L 64 28 L 0 28 Z`}
                fill={`url(#sparkline-gradient-${label})`}
              />
              <path
                d={sparklinePath}
                fill="none"
                stroke={direction === 'down' ? '#ef4444' : primaryColor}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
