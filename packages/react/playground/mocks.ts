// Mock data for testing components

export const mockInvoices = [
  {
    id: 'inv_001',
    invoiceNumber: 'INV-0001',
    status: 'paid' as const,
    invoiceDate: '2026-01-15',
    dueDate: '2026-01-30',
    totalAmount: '1,250.00',
    currency: 'USD',
    customer: { name: 'Acme Corp', email: 'billing@acme.example' },
  },
  {
    id: 'inv_002',
    invoiceNumber: 'INV-0002',
    status: 'pending' as const,
    invoiceDate: '2026-01-20',
    dueDate: '2026-02-05',
    totalAmount: '850.00',
    currency: 'USD',
    customer: { name: 'TechStart Inc', email: 'finance@techstart.example' },
  },
  {
    id: 'inv_003',
    invoiceNumber: 'INV-0003',
    status: 'overdue' as const,
    invoiceDate: '2026-01-01',
    dueDate: '2026-01-15',
    totalAmount: '2,100.00',
    currency: 'USD',
    customer: { name: 'Global Systems', email: 'ap@globalsys.example' },
  },
  {
    id: 'inv_004',
    invoiceNumber: 'INV-0004',
    status: 'draft' as const,
    invoiceDate: '2026-01-28',
    dueDate: '2026-02-12',
    totalAmount: '475.00',
    currency: 'USD',
    customer: { name: 'Startup Labs', email: 'hello@startuplabs.example' },
  },
];

export const mockInvoiceDetail = {
  id: 'inv_001',
  invoiceNumber: 'INV-0001',
  status: 'pending' as const,
  invoiceDate: '2026-01-15',
  dueDate: '2026-01-30',
  totalAmount: 1250.0,
  amountPaid: 0,
  amountDue: 1250.0,
  currency: 'USD',
  customer: {
    id: 'cust_001',
    name: 'Acme Corp',
    email: 'billing@acme.example',
  },
  lineItems: [
    { description: 'API Calls - Pro Plan', quantity: 10000, unitPrice: 0.10, amount: 1000.0 },
    { description: 'Data Storage (GB)', quantity: 50, unitPrice: 5.0, amount: 250.0 },
  ],
};

export const mockSubscription = {
  id: 'sub_001',
  status: 'active' as const,
  startDate: '2025-12-01',
  endDate: null,
  plan: {
    id: 'plan_pro',
    name: 'Professional',
    price: 99,
    billingCycle: 'monthly',
  },
  agent: {
    id: 'agent_001',
    name: 'AI Assistant Pro',
  },
  usage: {
    totalQuantity: 8542,
    totalEvents: 1247,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
  },
};

export const mockUsageData = [
  { date: '2026-01-01', quantity: 245, events: 32 },
  { date: '2026-01-02', quantity: 312, events: 45 },
  { date: '2026-01-03', quantity: 189, events: 28 },
  { date: '2026-01-04', quantity: 421, events: 56 },
  { date: '2026-01-05', quantity: 367, events: 48 },
  { date: '2026-01-06', quantity: 298, events: 41 },
  { date: '2026-01-07', quantity: 156, events: 22 },
  { date: '2026-01-08', quantity: 445, events: 61 },
  { date: '2026-01-09', quantity: 389, events: 52 },
  { date: '2026-01-10', quantity: 512, events: 67 },
];

export const mockPricingPlans = [
  {
    id: 'starter',
    name: 'Starter',
    price: 25,
    billingCycle: 'monthly' as const,
    features: ['10,000 API requests', 'Usage dashboard', 'Email support', 'Spend alerts'],
  },
  {
    id: 'premium',
    name: 'Premium',
    price: 60,
    billingCycle: 'monthly' as const,
    features: ['50,000 API requests', 'Usage dashboard', 'Email support', 'Spend alerts', 'Webhooks'],
    isPopular: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 150,
    billingCycle: 'monthly' as const,
    features: ['250,000 API requests', 'Usage dashboard', 'Webhooks', 'Team seats', 'Audit log'],
  },
  {
    id: 'scale',
    name: 'Scale',
    price: 299,
    billingCycle: 'monthly' as const,
    features: ['All Pro features', 'Priority support', 'Dedicated account manager', 'Custom integrations'],
  },
];

// Plans in the PricingPlanV2 shape (for EstimateCost, PlanQuiz, ROICalculator)
export const mockPricingPlansV2 = [
  {
    id: 'starter',
    name: 'Starter',
    price: 25,
    billingCycle: 'monthly' as const,
    features: ['10,000 API requests', 'Usage dashboard', 'Email support', 'Spend alerts'],
    enabled: true,
  },
  {
    id: 'premium',
    name: 'Premium',
    price: 60,
    billingCycle: 'monthly' as const,
    features: ['50,000 API requests', 'Usage dashboard', 'Email support', 'Spend alerts', 'Webhooks', 'Priority queue'],
    isPopular: true,
    enabled: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 150,
    billingCycle: 'monthly' as const,
    features: ['All Premium features', '250,000 API requests', 'Team seats', 'Audit log'],
    enabled: true,
  },
  {
    id: 'scale',
    name: 'Scale',
    price: 299,
    billingCycle: 'monthly' as const,
    features: ['All Pro features', 'Priority support', 'Dedicated account manager', 'Custom SLA'],
    enabled: true,
  },
];

// Mock business context for pricing components
export const mockBusinessContext = {
  productOverview: 'AI-powered API platform for developers',
  businessModel: 'Usage-based billing with tiered plans',
  pricingMechanics: 'Per API call pricing with volume discounts',
};

// ============================================================================
// Mock data for the full-page components
// ============================================================================

// Mock invoices with proper format for InvoiceHistory component
export const mockInvoicesForHistory = [
  {
    id: 'inv_001',
    invoiceNumber: 'INV-2026-001',
    status: 'paid' as const,
    invoiceDate: '2026-01-15',
    dueDate: '2026-01-30',
    totalAmount: 497.00,
    currency: 'USD',
  },
  {
    id: 'inv_002',
    invoiceNumber: 'INV-2026-002',
    status: 'pending' as const,
    invoiceDate: '2026-01-20',
    dueDate: '2026-02-05',
    totalAmount: 199.00,
    currency: 'USD',
  },
  {
    id: 'inv_003',
    invoiceNumber: 'INV-2026-003',
    status: 'overdue' as const,
    invoiceDate: '2026-01-01',
    dueDate: '2026-01-15',
    totalAmount: 249.00,
    currency: 'USD',
  },
  {
    id: 'inv_004',
    invoiceNumber: 'INV-2026-004',
    status: 'paid' as const,
    invoiceDate: '2025-12-15',
    dueDate: '2025-12-30',
    totalAmount: 350.00,
    currency: 'USD',
  },
  {
    id: 'inv_005',
    invoiceNumber: 'INV-2026-005',
    status: 'draft' as const,
    invoiceDate: '2026-01-28',
    dueDate: '2026-02-12',
    totalAmount: 175.00,
    currency: 'USD',
  },
];

// Mock order items for CheckoutForm component
export const mockOrderItems = [
  {
    name: 'Pro Plan (Monthly)',
    description: 'Usage-based billing',
    price: 49.00,
    quantity: 1,
  },
];
