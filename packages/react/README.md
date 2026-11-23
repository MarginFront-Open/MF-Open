# @marginfront/react

React components for MarginFront - pricing tables, invoices, usage charts, and billing UI.

## Installation

These packages are built from the MarginFront source; they are not installed from a public registry. Replace `<your MarginFront source URL>` below with the git address you got MarginFront from. From the folder that holds your app's folder:

```bash
git clone <your MarginFront source URL> marginfront
cd marginfront && npm ci && npx turbo run build --filter=@marginfront/react
```

Then, from your app's folder:

```bash
npm install ../marginfront/packages/sdk ../marginfront/packages/react
```

## Quick Start

`apiBaseUrl` is required: it is the address of your own MarginFront API, including `/v1`. The package has no built-in server address, and the provider throws a clear error if you leave it out.

```tsx
import { MarginFrontProvider, PricingTable, InvoiceList } from '@marginfront/react';

function App() {
  return (
    <MarginFrontProvider
      apiKey="mf_pk_your_api_key"
      apiBaseUrl="https://billing.example.com/v1"
      customerId="cust_123"
      theme={{ primary: '#047857' }}
    >
      <YourApp />
    </MarginFrontProvider>
  );
}

function BillingPage() {
  return (
    <div>
      <InvoiceList onInvoiceClick={(inv) => console.log(inv)} />
    </div>
  );
}
```

## Components

### PricingTable

Display pricing plans on your marketing page.

```tsx
import { PricingTable, type PricingPlan } from '@marginfront/react';

const plans: PricingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: 29,
    billingCycle: 'monthly',
    features: ['10,000 events/mo', 'Basic analytics', 'Email support'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 99,
    billingCycle: 'monthly',
    features: ['100,000 events/mo', 'Advanced analytics', 'Priority support'],
    isPopular: true,
  },
];

<PricingTable
  plans={plans}
  title="Simple, transparent pricing"
  onSelectPlan={(plan) => handleCheckout(plan)}
/>
```

### InvoiceViewer

Display a single invoice with line items and payment.

```tsx
import { InvoiceViewer } from '@marginfront/react';

<InvoiceViewer
  invoiceId="inv_123"
  showPayButton
  onPay={(invoice) => handlePayment(invoice)}
  onDownload={(invoice) => downloadPdf(invoice)}
/>
```

### InvoiceList

Display a list of customer invoices.

```tsx
import { InvoiceList } from '@marginfront/react';

<InvoiceList
  status="pending"
  limit={10}
  onInvoiceClick={(invoice) => router.push(`/invoices/${invoice.id}`)}
/>
```

### UsageChart

Display usage metrics with charts.

```tsx
import { UsageChart } from '@marginfront/react';

<UsageChart
  startDate="2024-01-01"
  endDate="2024-01-31"
  groupBy="daily"
  showSummary
/>
```

### SubscriptionCard

Display subscription details.

```tsx
import { SubscriptionCard } from '@marginfront/react';

<SubscriptionCard
  subscriptionId="sub_123"
  showUsage
  onManage={(sub) => openManageModal(sub)}
/>
```

## Hooks

### useMarginFront

Access the MarginFront client and context.

```tsx
const { client, isConnected, theme } = useMarginFront();
```

### useInvoices / useInvoice

Fetch invoices.

```tsx
const { invoices, isLoading, refetch } = useInvoices({ status: 'pending' });
const { invoice, isLoading } = useInvoice({ invoiceId: 'inv_123' });
```

### useUsage

Fetch usage analytics.

```tsx
const { summary, timeSeries, isLoading } = useUsage({
  startDate: '2024-01-01',
  endDate: '2024-01-31',
  groupBy: 'daily',
});
```

### useSubscriptions / useSubscription

Fetch subscriptions.

```tsx
const { subscriptions, isLoading } = useSubscriptions({ status: 'active' });
const { subscription, isLoading } = useSubscription({ subscriptionId: 'sub_123' });
```

## Theming

Customize the look of components via the provider:

```tsx
<MarginFrontProvider
  apiKey="mf_pk_..."
  apiBaseUrl="https://billing.example.com/v1"
  theme={{
    primary: '#047857',    // Primary brand color
    secondary: '#6B7280',  // Secondary color
    accent: '#10B981',     // Accent color
    borderRadius: '8px',   // Border radius
    fontFamily: 'Inter, sans-serif',
  }}
>
```

## TypeScript

Full TypeScript support included. Import types:

```tsx
import type {
  PricingPlan,
  MarginFrontTheme,
  MarginFrontContextValue,
} from '@marginfront/react';
```

## License

MIT
