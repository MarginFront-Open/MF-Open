'use client';

/**
 * UsageDashboard Component
 * Usage analytics with stat cards, bar chart, and time series, all from API data
 */

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { TrendingUp, TrendingDown, Zap, Database, Users, BarChart3, AlertCircle } from 'lucide-react';
import type { GroupBy } from '@marginfront/sdk';
import { useUsage } from '../hooks/useUsage';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';
import { ComponentHeader } from './primitives/ComponentHeader';

export interface UsageDashboardProps {
  /** Company/product name for header */
  companyName?: string;
  /** Logo URL or React node */
  logo?: string | React.ReactNode;
  /** Show header */
  showHeader?: boolean;
  /** Show period selector */
  showPeriodSelector?: boolean;
  /** Default period */
  defaultPeriod?: 'day' | 'week' | 'month';
  /** Custom class name */
  className?: string;
  /** Brand color override */
  brandColor?: string;
  /** Theme override */
  theme?: 'light' | 'dark';
}

// Sparkline component
function Sparkline({
  data,
  color,
  width = 50,
  height = 18,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
      <circle
        cx={width}
        cy={height - ((data[data.length - 1] - min) / range) * height}
        r="2"
        fill={color}
      />
    </svg>
  );
}

// Mini area chart for time series
function AreaChart({
  data,
  primaryColor,
  isDark,
  width = 280,
  height = 80,
}: {
  data: { date: string; value: number }[];
  primaryColor: string;
  isDark: boolean;
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) return null;

  const values = data.map((d) => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  const points = data.map((item, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - ((item.value - min) / range) * (height - 10) - 5;
    return { x, y, value: item.value, date: item.date };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaD = `${pathD} L ${width} ${height} L 0 ${height} Z`;

  // Use unique ID to avoid SVG gradient conflicts
  const gradientId = `areaGradient-${primaryColor.replace('#', '')}`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={primaryColor} stopOpacity="0.3" />
          <stop offset="100%" stopColor={primaryColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradientId})`} />
      <path
        d={pathD}
        fill="none"
        stroke={primaryColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r="3"
          fill={isDark ? '#1e293b' : 'white'}
          stroke={primaryColor}
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}

const PERIOD_CONFIG: Record<string, { groupBy: GroupBy; daysBack: number; bars: number }> = {
  day: { groupBy: 'daily', daysBack: 7, bars: 7 },
  week: { groupBy: 'weekly', daysBack: 56, bars: 8 },
  month: { groupBy: 'monthly', daysBack: 210, bars: 7 },
};

type TimeSeriesPoint = { date: string; quantity: number; cost: number; eventCount: number };

/**
 * Fill gaps in sparse time series so we always render the expected number of bars.
 * API only returns buckets that have data — this fills missing ones with zeros.
 * Aligns dates to natural boundaries so lookups match the API's date format:
 *   daily  → exact date
 *   weekly → Monday of each week
 *   monthly → 1st of each month
 */
function fillTimeSeriesGaps(
  series: TimeSeriesPoint[],
  startDate: string,
  groupBy: GroupBy,
  count: number,
): TimeSeriesPoint[] {
  if (series.length === 0) return [];

  // Build lookup keyed by the bucket key the API would use
  const lookup = new Map<string, TimeSeriesPoint>();
  for (const t of series) {
    lookup.set(bucketKey(t.date, groupBy), t);
  }

  // Generate aligned date buckets going backwards from today
  const buckets: string[] = [];
  const now = new Date();

  if (groupBy === 'monthly') {
    // Walk backwards from current month
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let i = 0; i < count; i++) {
      buckets.unshift(d.toISOString().split('T')[0]);
      d.setMonth(d.getMonth() - 1);
    }
  } else if (groupBy === 'weekly') {
    // Walk backwards from Monday of current week
    const d = new Date(now);
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); // align to Monday
    for (let i = 0; i < count; i++) {
      buckets.unshift(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() - 7);
    }
  } else {
    // Daily — walk backwards from today
    const d = new Date(now);
    for (let i = 0; i < count; i++) {
      buckets.unshift(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() - 1);
    }
  }

  return buckets.map((dateKey) => {
    const bk = bucketKey(dateKey, groupBy);
    return lookup.get(bk) ?? { date: dateKey, quantity: 0, cost: 0, eventCount: 0 };
  });
}

/** Normalize a date string to its bucket key so API dates match generated dates */
function bucketKey(dateStr: string, groupBy: GroupBy): string {
  const d = new Date(dateStr);
  if (groupBy === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  if (groupBy === 'weekly') {
    // Normalize to Monday of that week
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return d.toISOString().split('T')[0];
  }
  return dateStr;
}

export function UsageDashboard({
  companyName = 'Your Product',
  logo,
  showHeader = false,
  showPeriodSelector = true,
  defaultPeriod = 'week',
  className,
  brandColor,
  theme: themeProp,
}: UsageDashboardProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = brandColor || contextTheme.primary || '#047857';

  const [period, setPeriod] = useState<'day' | 'week' | 'month'>(defaultPeriod);
  const isDark = themeProp === 'dark';

  // Calculate date range
  const { startDate, endDate } = useMemo(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - PERIOD_CONFIG[period].daysBack);
    return {
      startDate: start.toISOString().split('T')[0],
      endDate: end.toISOString().split('T')[0],
    };
  }, [period]);

  // Fetch usage data
  const { data: _usageData, summary, timeSeries, isLoading, error } = useUsage({
    startDate,
    endDate,
    groupBy: PERIOD_CONFIG[period].groupBy,
  });

  // Stats derived from API data
  const statsData = useMemo(() => {
    const totalQuantity = summary?.totalQuantity ?? 0;
    const totalCost = summary?.totalCost ?? 0;
    const totalEvents = summary?.totalEvents ?? 0;
    const uniqueCustomers = summary?.uniqueCustomers ?? 0;

    // Calculate trend from time series (compare last half vs first half)
    const calcTrend = (values: number[]): { change: string; direction: 'up' | 'down' | 'neutral' } => {
      if (values.length < 2) return { change: '—', direction: 'neutral' };
      const mid = Math.floor(values.length / 2);
      const firstHalf = values.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const secondHalf = values.slice(mid).reduce((a, b) => a + b, 0) / (values.length - mid);
      if (firstHalf === 0) return { change: '—', direction: 'neutral' };
      const pct = ((secondHalf - firstHalf) / firstHalf) * 100;
      return {
        change: `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`,
        direction: pct >= 0 ? 'up' : 'down',
      };
    };

    const quantityValues = timeSeries.map((t) => t.quantity);
    const costValues = timeSeries.map((t) => t.cost);
    const eventValues = timeSeries.map((t) => t.eventCount ?? t.quantity);

    const quantityTrend = calcTrend(quantityValues);
    const costTrend = calcTrend(costValues);
    const eventTrend = calcTrend(eventValues);

    return [
      {
        label: 'Total Usage',
        value: formatNumber(totalQuantity),
        change: quantityTrend.change,
        trend: quantityTrend.direction,
        icon: Zap,
        sparkline: quantityValues.slice(-10),
      },
      {
        label: 'Total Cost',
        value: `$${totalCost.toFixed(2)}`,
        change: costTrend.change,
        trend: costTrend.direction,
        icon: Database,
        sparkline: costValues.slice(-10),
      },
      {
        label: 'Events',
        value: formatNumber(totalEvents),
        change: eventTrend.change,
        trend: eventTrend.direction,
        icon: BarChart3,
        sparkline: eventValues.slice(-10),
      },
      {
        label: 'Customers',
        value: formatNumber(uniqueCustomers),
        change: '—',
        trend: 'neutral' as const,
        icon: Users,
        sparkline: [],
      },
    ];
  }, [summary, timeSeries]);

  // Bar chart from the time series. Fill gaps so we always show expected bar count
  const barData = useMemo(() => {
    const config = PERIOD_CONFIG[period];
    const filled = fillTimeSeriesGaps(timeSeries as TimeSeriesPoint[], startDate, config.groupBy, config.bars);

    return filled.map((t) => ({
      label: formatBarLabel(t.date, period),
      usage: t.quantity,
      cost: t.cost,
    }));
  }, [timeSeries, period, startDate]);

  // Cost time series for area chart — use same filled data for consistency
  const costChartData = useMemo(() => {
    const config = PERIOD_CONFIG[period];
    const filled = fillTimeSeriesGaps(timeSeries as TimeSeriesPoint[], startDate, config.groupBy, config.bars);
    if (filled.length === 0) return [];
    return filled.map((t) => ({
      date: t.date,
      value: t.cost,
    }));
  }, [timeSeries, period, startDate]);

  const getThemeStyles = () => {
    if (isDark) {
      return {
        bg: 'bg-slate-900',
        cardBg: 'bg-slate-800',
        text: 'text-white',
        textMuted: 'text-slate-400',
        border: 'border-slate-700',
      };
    }
    return {
      bg: 'bg-white',
      cardBg: 'bg-gray-50',
      text: 'text-gray-900',
      textMuted: 'text-gray-600',
      border: 'border-gray-200',
    };
  };

  const styles = getThemeStyles();
  const maxBarUsage = barData.length > 0 ? Math.max(...barData.map((d) => d.usage)) : 1;

  // Error state
  if (error) {
    return (
      <div className={cn('marginfront-usage-dashboard rounded-xl border overflow-hidden', styles.bg, styles.border, className)}>
        <div className="p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3">
            <AlertCircle className="w-6 h-6 text-red-500" />
          </div>
          <p className={cn('font-medium', styles.text)}>Failed to load usage data</p>
          <p className={cn('text-sm mt-1', styles.textMuted)}>{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'marginfront-usage-dashboard rounded-xl overflow-hidden border',
        styles.bg,
        styles.border,
        className
      )}
    >
      {/* Header */}
      {showHeader && (
        <ComponentHeader
          companyName={companyName}
          logo={logo}
          componentLabel="Usage Dashboard"
          brandColor={primaryColor}
        />
      )}

      <div className="p-4">
        {/* Period Selector */}
        {showPeriodSelector && (
          <div className="flex gap-1 mb-4">
            {(['day', 'week', 'month'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                  period === p
                    ? 'text-white'
                    : isDark
                    ? 'text-slate-400 hover:bg-slate-700'
                    : 'text-gray-500 hover:bg-gray-100'
                )}
                style={period === p ? { backgroundColor: primaryColor } : undefined}
              >
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        )}

        {/* Content with AnimatePresence to avoid flash */}
        <AnimatePresence mode="wait">
          {isLoading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="space-y-3"
            >
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className={cn('rounded-xl p-3 border animate-pulse', styles.cardBg, styles.border)}>
                    <div className="h-4 w-10 bg-gray-200 rounded mb-2" />
                    <div className="h-5 w-16 bg-gray-200 rounded" />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className={cn('rounded-xl p-3 border h-36 animate-pulse', styles.cardBg, styles.border)} />
                <div className={cn('rounded-xl p-3 border h-36 animate-pulse', styles.cardBg, styles.border)} />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={`content-${period}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="space-y-3"
            >
              {/* Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {statsData.map((stat, index) => {
                  const Icon = stat.icon;
                  const hasTrend = stat.change !== '—';
                  return (
                    <motion.div
                      key={stat.label}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 * (index + 1) }}
                      className={cn('rounded-xl p-3 border relative overflow-hidden', styles.cardBg, styles.border)}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: `${primaryColor}15` }}
                        >
                          <Icon className="w-3.5 h-3.5" style={{ color: primaryColor }} />
                        </div>
                        {hasTrend && (
                          <div
                            className="flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={{
                              color: primaryColor,
                              backgroundColor: `${primaryColor}10`,
                            }}
                          >
                            {stat.trend === 'up' ? (
                              <TrendingUp className="w-2.5 h-2.5" />
                            ) : stat.trend === 'down' ? (
                              <TrendingDown className="w-2.5 h-2.5" />
                            ) : null}
                            {stat.change}
                          </div>
                        )}
                      </div>
                      <div className="flex items-end justify-between">
                        <div>
                          <div className={cn('text-lg font-bold leading-none mb-0.5', styles.text)}>{stat.value}</div>
                          <div className={cn('text-[10px]', styles.textMuted)}>{stat.label}</div>
                        </div>
                        {stat.sparkline.length >= 2 && (
                          <div className="opacity-80">
                            <Sparkline
                              data={stat.sparkline}
                              color={primaryColor}
                              width={50}
                              height={18}
                            />
                          </div>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>

              {/* Charts Row */}
              {(barData.length > 0 || timeSeries.length > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Bar Chart - Usage by period */}
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.25 }}
                    className={cn('rounded-xl p-3 border', styles.cardBg, styles.border)}
                  >
                    <div className="mb-3">
                      <h3 className={cn('text-xs font-semibold', styles.text)}>Usage by Period</h3>
                      <p className={cn('text-[10px]', styles.textMuted)}>
                        Quantity per {PERIOD_CONFIG[period].groupBy === 'daily' ? 'day' : PERIOD_CONFIG[period].groupBy === 'weekly' ? 'week' : 'month'}
                      </p>
                    </div>
                    <div className="flex items-end justify-between gap-1.5 h-20 mb-2">
                      {barData.map((data, index) => (
                        <motion.div
                          key={data.label}
                          className="flex-1 flex flex-col items-center gap-1.5"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.3 + index * 0.03 }}
                        >
                          <div className="w-full flex justify-center" style={{ height: '60px', alignItems: 'flex-end' }}>
                            <motion.div
                              className="w-full max-w-[20px] rounded-md"
                              style={{ backgroundColor: `${primaryColor}20` }}
                              initial={{ height: 0 }}
                              animate={{ height: `${maxBarUsage > 0 ? Math.max((data.usage / maxBarUsage) * 100, 4) : 4}%` }}
                              transition={{ delay: 0.35 + index * 0.03, duration: 0.4, ease: 'easeOut' }}
                            >
                              <div
                                className="w-full h-full rounded-md"
                                style={{ backgroundColor: primaryColor, opacity: 0.7 + (data.usage / maxBarUsage) * 0.3 }}
                              />
                            </motion.div>
                          </div>
                          <span className={cn('text-[9px] font-medium', styles.textMuted)}>{data.label}</span>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>

                  {/* Area Chart - Cost over time */}
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className={cn('rounded-xl p-3 border', styles.cardBg, styles.border)}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h3 className={cn('text-xs font-semibold', styles.text)}>Cost Over Time</h3>
                        <p className={cn('text-[10px]', styles.textMuted)}>
                          Spend per {PERIOD_CONFIG[period].groupBy === 'daily' ? 'day' : PERIOD_CONFIG[period].groupBy === 'weekly' ? 'week' : 'month'}
                        </p>
                      </div>
                      {summary && (
                        <span className="text-sm font-bold" style={{ color: primaryColor }}>
                          ${summary.totalCost.toFixed(2)}
                        </span>
                      )}
                    </div>
                    <div className="relative h-20">
                      <AreaChart
                        data={costChartData}
                        primaryColor={primaryColor}
                        isDark={isDark}
                        width={280}
                        height={80}
                      />
                    </div>
                    {costChartData.length > 0 && (
                      <div className="flex justify-between px-1 mt-1">
                        <span className={cn('text-[8px]', styles.textMuted)}>
                          {formatChartDate(costChartData[0].date)}
                        </span>
                        <span className={cn('text-[8px]', styles.textMuted)}>
                          {formatChartDate(costChartData[costChartData.length - 1].date)}
                        </span>
                      </div>
                    )}
                  </motion.div>
                </div>
              )}

              {/* Empty state when no data at all */}
              {timeSeries.length === 0 && barData.length === 0 && !isLoading && (
                <div className={cn('rounded-xl p-8 border text-center', styles.cardBg, styles.border)}>
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3"
                    style={{ backgroundColor: `${primaryColor}15` }}
                  >
                    <BarChart3 className="w-6 h-6" style={{ color: primaryColor }} />
                  </div>
                  <p className={cn('text-sm font-medium', styles.text)}>No usage data</p>
                  <p className={cn('text-xs mt-1', styles.textMuted)}>
                    No events recorded for this period
                  </p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatBarLabel(dateStr: string, period: string): string {
  const date = new Date(dateStr);
  if (period === 'day') {
    // Daily bars — short day name (Mon, Tue, ...)
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }
  if (period === 'week') {
    // Weekly bars — short date (Jan 6, Jan 13, ...)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  // Monthly bars — month name (Jan, Feb, ...)
  return date.toLocaleDateString('en-US', { month: 'short' });
}

function formatChartDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
