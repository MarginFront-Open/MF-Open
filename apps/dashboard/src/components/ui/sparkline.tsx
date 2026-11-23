import { LineChart, Line, ResponsiveContainer, Area, AreaChart } from 'recharts'

interface SparklineProps {
  data: number[]
  color?: string
  height?: number
  className?: string
  variant?: 'line' | 'area'
}

export function Sparkline({
  data,
  color = 'hsl(var(--primary))',
  height = 40,
  className = '',
  variant = 'area',
}: SparklineProps) {
  // Convert array of numbers to recharts format
  const chartData = data.map((value, index) => ({
    index,
    value,
  }))

  // Extract RGB values from color for gradient
  const gradientId = `gradient-${color.replace(/[^\w]/g, '')}`

  if (variant === 'area') {
    return (
      <div className={className} style={{ height: `${height}px` }}>
        <ResponsiveContainer width='100%' height='100%'>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id={gradientId} x1='0' y1='0' x2='0' y2='1'>
                <stop offset='5%' stopColor={color} stopOpacity={0.3} />
                <stop offset='95%' stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type='monotone'
              dataKey='value'
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              isAnimationActive={true}
              animationDuration={1200}
              animationEasing='ease-in-out'
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    )
  }

  return (
    <div className={className} style={{ height: `${height}px` }}>
      <ResponsiveContainer width='100%' height='100%'>
        <LineChart data={chartData}>
          <Line
            type='monotone'
            dataKey='value'
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={true}
            animationDuration={1200}
            animationEasing='ease-in-out'
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
