import { IconChevronDown } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import { InfoTooltip } from '@/components/ui/info-tooltip'

interface SignalBasedPricingSectionProps {
  title: string
  enabled: boolean
  onToggle: () => void
  children: React.ReactNode
  tooltip?: { title: string; description: string; details?: string }
}

export function SignalBasedPricingSection({
  title,
  enabled,
  onToggle,
  children,
  tooltip,
}: SignalBasedPricingSectionProps) {
  return (
    <Card className='border shadow-sm'>
      <CardContent className='p-0'>
        <div className='flex items-center justify-between p-4'>
          <div className='flex items-center gap-2'>
            <span className='font-medium'>{title}</span>
            {tooltip && <InfoTooltip {...tooltip} />}
          </div>
          <div className='flex items-center gap-4'>
            <Badge variant='outline' className='font-normal'>
              USAGE
            </Badge>
            <Badge variant='outline' className='font-normal'>
              VARIABLE
            </Badge>
            <Badge variant='outline' className='font-normal'>
              RECURRING
            </Badge>
            <Switch checked={enabled} onCheckedChange={onToggle} />
            <IconChevronDown size={16} />
          </div>
        </div>

        {enabled && (
          <Collapsible defaultOpen>
            <CollapsibleContent className='px-4 pb-4'>
              {children}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}
