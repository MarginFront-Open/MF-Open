import { Calculator, FileText, TrendingUp } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BillingStatusViewer } from './components/billing-status-viewer'
import { InvoicePreviewCalculator } from './components/invoice-preview-calculator'
import { RevenueSimulator } from './components/revenue-simulator'

export default function InvoiceCalculatorPage() {
  return (
    <div className='flex-1 space-y-4 p-4 pt-6 md:p-8'>
      <div className='flex items-center justify-between space-y-2'>
        <div>
          <h2 className='text-3xl font-bold tracking-tight'>
            Invoice Calculator
          </h2>
          <p className='text-muted-foreground'>
            Calculate invoices, simulate revenue, and preview billing scenarios
          </p>
        </div>
      </div>

      <Tabs defaultValue='simulator' className='space-y-4'>
        <TabsList>
          <TabsTrigger value='simulator' className='gap-2'>
            <TrendingUp className='h-4 w-4' />
            Revenue Simulator
          </TabsTrigger>
          <TabsTrigger value='calculator' className='gap-2'>
            <Calculator className='h-4 w-4' />
            Invoice Preview
          </TabsTrigger>
          <TabsTrigger value='billing-status' className='gap-2'>
            <FileText className='h-4 w-4' />
            Billing Status
          </TabsTrigger>
        </TabsList>

        <TabsContent value='simulator' className='space-y-4'>
          <RevenueSimulator />
        </TabsContent>

        <TabsContent value='calculator' className='space-y-4'>
          <InvoicePreviewCalculator />
        </TabsContent>

        <TabsContent value='billing-status' className='space-y-4'>
          <BillingStatusViewer />
        </TabsContent>
      </Tabs>
    </div>
  )
}
