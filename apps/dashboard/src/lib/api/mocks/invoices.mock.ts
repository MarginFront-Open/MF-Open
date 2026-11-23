/**
 * Mock Invoice Data
 *
 * Mock data for UI development.
 * Includes 4 invoices (one per status) for comprehensive UI testing.
 */
import type { Invoice, Customer, InvoiceSubscription } from '../invoices'

// Extended invoice interface for mock data
export interface MockInvoiceItem {
  id: string
  invoiceId: string
  description: string
  quantity: string
  unitPrice: string
  amount: string
  type: string
  metadata?: Record<string, unknown>
}

export interface MockInvoiceWithDetails extends Invoice {
  items: MockInvoiceItem[]
  payments: Array<{
    date: string
    method: string
    amount: string
  }>
}

// Mock Customers
const mockCustomers: Record<string, Customer> = {
  cus_001: {
    id: 'cus_001',
    name: 'Acme Corporation',
    email: 'billing@acme.example',
  },
  cus_002: {
    id: 'cus_002',
    name: 'TechStart Inc',
    email: 'accounts@techstart.example',
  },
  cus_003: {
    id: 'cus_003',
    name: 'GlobalCorp Ltd',
    email: 'finance@globalcorp.example',
  },
  cus_004: {
    id: 'cus_004',
    name: 'Sunset Ventures',
    email: 'billing@sunsetventures.example',
  },
}

// Mock Subscriptions
const mockSubscriptions: Record<string, InvoiceSubscription> = {
  sub_001: {
    id: 'sub_001',
    name: 'Pro Plan - Monthly',
    startDate: '2024-01-01T00:00:00Z',
    status: 'active',
    billingCycle: 'monthly',
    plan: { id: 'plan_pro', name: 'Pro Plan' },
    agent: { id: 'agent_001', name: 'Sales Bot' },
  },
  sub_002: {
    id: 'sub_002',
    name: 'Starter Plan - Monthly',
    startDate: '2024-06-01T00:00:00Z',
    status: 'active',
    billingCycle: 'monthly',
    plan: { id: 'plan_starter', name: 'Starter Plan' },
    agent: { id: 'agent_002', name: 'Support Bot' },
  },
  sub_003: {
    id: 'sub_003',
    name: 'Enterprise Plan - Yearly',
    startDate: '2024-01-01T00:00:00Z',
    status: 'active',
    billingCycle: 'yearly',
    plan: { id: 'plan_enterprise', name: 'Enterprise Plan' },
    agent: { id: 'agent_003', name: 'Enterprise Bot' },
  },
  sub_004: {
    id: 'sub_004',
    name: 'Basic Plan - Monthly',
    startDate: '2024-03-01T00:00:00Z',
    status: 'canceled',
    billingCycle: 'monthly',
    plan: { id: 'plan_basic', name: 'Basic Plan' },
    agent: { id: 'agent_004', name: 'Basic Bot' },
  },
}

// Mock Invoices - One per status
export const mockInvoices: MockInvoiceWithDetails[] = [
  // FINALIZED (Pending payment, NOT overdue)
  {
    id: 'inv_001',
    invoiceNumber: 'INV-2025-0001',
    customerId: 'cus_001',
    subscriptionId: 'sub_001',
    invoiceDate: '2025-12-01T00:00:00Z',
    dueDate: '2025-12-31T00:00:00Z', // Future date - not overdue
    billingPeriodStart: '2025-12-01T00:00:00Z',
    billingPeriodEnd: '2025-12-31T00:00:00Z',
    totalAmount: '1098.90',
    subtotal: '999.00',
    taxAmount: '99.90',
    discountAmount: '0.00',
    amountPaid: '0.00',
    amountCredited: '0.00',
    amountDue: '1098.90',
    status: 'pending',
    createdAt: '2025-12-01T10:00:00Z',
    updatedAt: '2025-12-01T10:00:00Z',
    customer: mockCustomers.cus_001,
    subscription: mockSubscriptions.sub_001,
    items: [
      {
        id: 'li_001',
        invoiceId: 'inv_001',
        description: 'Pro Plan - December 2025',
        quantity: '1',
        unitPrice: '999.00',
        amount: '999.00',
        type: 'subscription',
      },
    ],
    payments: [],
  },

  // PAID
  {
    id: 'inv_002',
    invoiceNumber: 'INV-2025-0002',
    customerId: 'cus_002',
    subscriptionId: 'sub_002',
    invoiceDate: '2025-10-15T00:00:00Z',
    dueDate: '2025-10-30T00:00:00Z',
    billingPeriodStart: '2025-10-01T00:00:00Z',
    billingPeriodEnd: '2025-10-31T00:00:00Z',
    totalAmount: '548.90',
    subtotal: '499.00',
    taxAmount: '49.90',
    discountAmount: '0.00',
    amountPaid: '548.90',
    amountCredited: '0.00',
    amountDue: '0.00',
    status: 'paid',
    createdAt: '2025-10-15T09:00:00Z',
    updatedAt: '2025-10-28T14:32:00Z',
    customer: mockCustomers.cus_002,
    subscription: mockSubscriptions.sub_002,
    items: [
      {
        id: 'li_002',
        invoiceId: 'inv_002',
        description: 'Starter Plan - October 2025',
        quantity: '1',
        unitPrice: '499.00',
        amount: '499.00',
        type: 'subscription',
      },
    ],
    payments: [
      {
        date: '2025-10-28',
        method: 'Credit Card (Visa ****4242)',
        amount: '$548.90',
      },
    ],
  },

  // DRAFT (No invoice number yet)
  {
    id: 'inv_003',
    invoiceNumber: '', // Assigned on finalize
    customerId: 'cus_003',
    subscriptionId: 'sub_003',
    invoiceDate: '2025-12-10T00:00:00Z',
    dueDate: '2025-12-25T00:00:00Z',
    billingPeriodStart: '2025-12-01T00:00:00Z',
    billingPeriodEnd: '2025-12-31T00:00:00Z',
    totalAmount: '3298.90',
    subtotal: '2999.00',
    taxAmount: '299.90',
    discountAmount: '0.00',
    amountPaid: '0.00',
    amountCredited: '0.00',
    amountDue: '3298.90',
    status: 'draft',
    createdAt: '2025-12-10T08:00:00Z',
    updatedAt: '2025-12-10T08:00:00Z',
    customer: mockCustomers.cus_003,
    subscription: mockSubscriptions.sub_003,
    items: [
      {
        id: 'li_003',
        invoiceId: 'inv_003',
        description: 'Enterprise Plan - December 2025',
        quantity: '1',
        unitPrice: '2499.00',
        amount: '2499.00',
        type: 'subscription',
      },
      {
        id: 'li_004',
        invoiceId: 'inv_003',
        description: 'Additional API Calls (50,000)',
        quantity: '50',
        unitPrice: '10.00',
        amount: '500.00',
        type: 'usage',
      },
    ],
    payments: [],
  },

  // VOID
  {
    id: 'inv_004',
    invoiceNumber: 'INV-2025-0003',
    customerId: 'cus_004',
    subscriptionId: 'sub_004',
    invoiceDate: '2025-09-01T00:00:00Z',
    dueDate: '2025-09-15T00:00:00Z',
    billingPeriodStart: '2025-09-01T00:00:00Z',
    billingPeriodEnd: '2025-09-30T00:00:00Z',
    totalAmount: '218.90',
    subtotal: '199.00',
    taxAmount: '19.90',
    discountAmount: '0.00',
    amountPaid: '0.00',
    amountCredited: '0.00',
    amountDue: '218.90',
    status: 'void',
    createdAt: '2025-09-01T11:00:00Z',
    updatedAt: '2025-09-10T16:45:00Z',
    customer: mockCustomers.cus_004,
    subscription: mockSubscriptions.sub_004,
    items: [
      {
        id: 'li_005',
        invoiceId: 'inv_004',
        description: 'Basic Plan - September 2025',
        quantity: '1',
        unitPrice: '199.00',
        amount: '199.00',
        type: 'subscription',
      },
    ],
    payments: [],
  },

  // OVERDUE (Finalized but past due date)
  {
    id: 'inv_005',
    invoiceNumber: 'INV-2025-0004',
    customerId: 'cus_001',
    subscriptionId: 'sub_001',
    invoiceDate: '2025-11-01T00:00:00Z',
    dueDate: '2025-11-15T00:00:00Z', // Past date - overdue
    billingPeriodStart: '2025-11-01T00:00:00Z',
    billingPeriodEnd: '2025-11-30T00:00:00Z',
    totalAmount: '1098.90',
    subtotal: '999.00',
    taxAmount: '99.90',
    discountAmount: '0.00',
    amountPaid: '0.00',
    amountCredited: '0.00',
    amountDue: '1098.90',
    status: 'pending', // Finalized but overdue (computed)
    createdAt: '2025-11-01T10:00:00Z',
    updatedAt: '2025-11-01T10:00:00Z',
    customer: mockCustomers.cus_001,
    subscription: mockSubscriptions.sub_001,
    items: [
      {
        id: 'li_006',
        invoiceId: 'inv_005',
        description: 'Pro Plan - November 2025',
        quantity: '1',
        unitPrice: '999.00',
        amount: '999.00',
        type: 'subscription',
      },
    ],
    payments: [],
  },
]

// Simulate network delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// In-memory state for mutations
let invoiceState = [...mockInvoices]

/**
 * Mock Invoices API
 * Mimics real API behavior with delays and state mutations
 */
export const mockInvoicesApi = {
  /**
   * Get all invoices with optional filtering
   */
  getInvoices: async (_params?: Record<string, unknown>) => {
    await delay(300)
    return {
      results: invoiceState.map((inv) => ({
        ...inv,
        // Strip detailed fields for list view
        items: undefined,
        payments: undefined,
      })),
      totalResults: invoiceState.length,
    }
  },

  /**
   * Get a single invoice by ID
   */
  getInvoice: async (invoiceId: string, _includeDetails?: boolean) => {
    await delay(200)
    const invoice = invoiceState.find((i) => i.id === invoiceId)
    if (!invoice) {
      throw new Error('Invoice not found')
    }
    return { ...invoice }
  },

  /**
   * Mark invoice as paid
   */
  markPaid: async (invoiceId: string) => {
    await delay(400)
    const invoiceIndex = invoiceState.findIndex((i) => i.id === invoiceId)
    if (invoiceIndex === -1) {
      throw new Error('Invoice not found')
    }

    const invoice = invoiceState[invoiceIndex]
    if (invoice.status !== 'pending' && invoice.status !== 'issued') {
      throw new Error('Can only mark finalized/pending invoices as paid')
    }

    invoiceState[invoiceIndex] = {
      ...invoice,
      status: 'paid',
      amountPaid: invoice.totalAmount,
      updatedAt: new Date().toISOString(),
      payments: [
        ...invoice.payments,
        {
          date: new Date().toISOString().split('T')[0],
          method: 'Manual Entry',
          amount: `$${invoice.totalAmount}`,
        },
      ],
    }

    return { ...invoiceState[invoiceIndex] }
  },

  /**
   * Void an invoice
   */
  voidInvoice: async (invoiceId: string) => {
    await delay(400)
    const invoiceIndex = invoiceState.findIndex((i) => i.id === invoiceId)
    if (invoiceIndex === -1) {
      throw new Error('Invoice not found')
    }

    const invoice = invoiceState[invoiceIndex]
    if (invoice.status === 'paid') {
      throw new Error('Cannot void paid invoices')
    }
    if (invoice.status === 'void') {
      throw new Error('Invoice is already voided')
    }

    invoiceState[invoiceIndex] = {
      ...invoice,
      status: 'void',
      updatedAt: new Date().toISOString(),
    }

    return { ...invoiceState[invoiceIndex] }
  },

  /**
   * Finalize a draft invoice
   */
  finalize: async (invoiceId: string) => {
    await delay(400)
    const invoiceIndex = invoiceState.findIndex((i) => i.id === invoiceId)
    if (invoiceIndex === -1) {
      throw new Error('Invoice not found')
    }

    const invoice = invoiceState[invoiceIndex]
    if (invoice.status !== 'draft') {
      throw new Error('Can only finalize draft invoices')
    }

    // Generate invoice number
    const existingNumbers = invoiceState
      .filter((i) => i.invoiceNumber)
      .map((i) => {
        const match = i.invoiceNumber.match(/INV-2025-(\d+)/)
        return match ? parseInt(match[1], 10) : 0
      })
    const nextNumber = Math.max(0, ...existingNumbers) + 1

    invoiceState[invoiceIndex] = {
      ...invoice,
      status: 'pending',
      invoiceNumber: `INV-2025-${String(nextNumber).padStart(4, '0')}`,
      updatedAt: new Date().toISOString(),
    }

    return { ...invoiceState[invoiceIndex] }
  },

  /**
   * Reset mock data (useful for testing)
   */
  reset: () => {
    invoiceState = [...mockInvoices]
  },
}
