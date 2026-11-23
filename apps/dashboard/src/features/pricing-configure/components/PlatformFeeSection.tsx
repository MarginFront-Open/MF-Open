import { IconChevronDown } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

interface PlatformFeeSectionProps {
  enabled: boolean
  price: number
  billingFrequency: 'monthly' | 'yearly'
  currencySymbol: string
  onToggle: () => void
  onPriceChange: (price: number) => void
  onBillingFrequencyChange: (frequency: 'monthly' | 'yearly') => void
}

export function PlatformFeeSection({
  enabled,
  price,
  billingFrequency,
  currencySymbol,
  onToggle,
  onPriceChange,
  onBillingFrequencyChange,
}: PlatformFeeSectionProps) {
  return (
    <Card className='border shadow-sm'>
      <CardContent className='p-0'>
        <div className='flex items-center justify-between p-4'>
          <div className='flex items-center gap-2'>
            <span className='font-medium'>Platform fee</span>
            <InfoTooltip {...tooltipDefinitions.platformFee} />
          </div>
          <div className='flex items-center gap-4'>
            <Badge variant='outline' className='font-normal'>
              FIXED
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
            <CollapsibleContent className='mt-4 border-t p-4 pt-0'>
              <div className='space-y-4'>
                <div className='space-y-2'>
                  <Label>Price</Label>
                  <div className='flex items-center'>
                    <span className='mr-2'>{currencySymbol}</span>
                    <Input
                      type='number'
                      value={price === 0 ? '' : price}
                      placeholder='0'
                      onChange={(e) =>
                        onPriceChange(
                          e.target.value === '' ? 0 : Number(e.target.value)
                        )
                      }
                      className='max-w-[150px]'
                      min={0}
                    />
                  </div>
                </div>

                <div className='space-y-2'>
                  <Label>Billing frequency</Label>
                  <Select
                    value={billingFrequency}
                    onValueChange={onBillingFrequencyChange}
                  >
                    <SelectTrigger className='max-w-[200px]'>
                      <SelectValue placeholder='Select frequency' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='monthly'>Monthly</SelectItem>
                      <SelectItem value='yearly'>Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}
