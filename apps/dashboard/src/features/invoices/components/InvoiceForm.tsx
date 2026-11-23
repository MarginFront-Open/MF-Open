/**
 * Invoice Form Component
 *
 * Slide-out form for creating and editing invoices.
 * Supports dynamic line items with real-time total calculation.
 */
'use client'

import { useState, useEffect, useMemo } from 'react'
import { useFilters } from '@/services/filters-service'
import { XIcon, PlusIcon, TrashIcon, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/canon-format'
import type {
  Invoice,
  CreateInvoicePayload,
  UpdateInvoicePayload,
  InvoiceLineItemPayload,
} from '@/lib/api/invoices'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCreateInvoice, useUpdateInvoice } from '../useInvoiceMutations'

/**
 * Invoice Form Component
 *
 * Slide-out form for creating and editing invoices.
 * Supports dynamic line items with real-time total calculation.
 */

interface LineItem {
  id?: string
  description: string
  quantity: number
  unitPrice: number
  type: 'recurring' | 'usage' | 'onetime' | 'tax' | 'discount' | 'seat_based'
}

interface InvoiceFormProps {
  isOpen: boolean
  onClose?: () => void
  onOpenChange?: (open: boolean) => void
  onSuccess?: (invoice: Invoice) => void
  // For edit mode
  invoice?: Invoice & {
    items?: Array<{
      id: string
      description: string
      quantity: string
      unitPrice: string
      type: string
    }>
  }
  mode?: 'create' | 'edit'
}

const defaultLineItem: LineItem = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  type: 'onetime',
}

export function InvoiceForm({
  isOpen,
  onClose,
  onOpenChange,
  onSuccess,
  invoice,
  mode = 'create',
}: InvoiceFormProps) {
  const router = useRouter()
  const { data: filtersData, isLoading: _isLoadingFilters } = useFilters()
  const { mutate: createInvoice, isPending: isCreating } = useCreateInvoice()
  const { mutate: updateInvoice, isPending: isUpdating } = useUpdateInvoice()

  const customers = filtersData?.customers || []
  const subscriptions = filtersData?.subscriptions || []

  // Form state
  const [customerId, setCustomerId] = useState('')
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null)
  const [invoiceDate, setInvoiceDate] = useState(
    new Date().toISOString().split('T')[0]
  )
  const [dueDate, setDueDate] = useState(() => {
    const date = new Date()
    date.setDate(date.getDate() + 30)
    return date.toISOString().split('T')[0]
  })
  const [taxAmount, setTaxAmount] = useState(0)
  const [discountAmount, setDiscountAmount] = useState(0)
  const [memo, setMemo] = useState('')
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { ...defaultLineItem },
  ])

  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [formSubmitted, setFormSubmitted] = useState(false)

  // Filter subscriptions by selected customer
  const customerSubscriptions = useMemo(() => {
    if (!customerId) return []
    return subscriptions.filter((sub) => sub.customerId === customerId)
  }, [customerId, subscriptions])

  // Initialize form for edit mode
  /* eslint-disable react-hooks/set-state-in-effect -- Intentional form population from prop */
  useEffect(() => {
    if (mode === 'edit' && invoice) {
      setCustomerId(invoice.customerId)
      setSubscriptionId(invoice.subscriptionId || null)
      setInvoiceDate(invoice.invoiceDate?.split('T')[0] || '')
      setDueDate(invoice.dueDate?.split('T')[0] || '')
      setTaxAmount(parseFloat(invoice.taxAmount || '0'))
      setDiscountAmount(parseFloat(invoice.discountAmount || '0'))
      setMemo((invoice as any).memo || '')

      if (invoice.items && invoice.items.length > 0) {
        setLineItems(
          invoice.items.map((item) => ({
            id: item.id,
            description: item.description,
            quantity: parseFloat(item.quantity),
            unitPrice: parseFloat(item.unitPrice),
            type: item.type as LineItem['type'],
          }))
        )
      }
    }
  }, [mode, invoice])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Calculate totals
  const subtotal = useMemo(() => {
    return lineItems.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0
    )
  }, [lineItems])

  const total = useMemo(() => {
    return subtotal + taxAmount - discountAmount
  }, [subtotal, taxAmount, discountAmount])

  // Line item handlers
  const addLineItem = () => {
    setLineItems([...lineItems, { ...defaultLineItem }])
  }

  const removeLineItem = (index: number) => {
    if (lineItems.length === 1) return
    setLineItems(lineItems.filter((_, i) => i !== index))
  }

  const updateLineItem = (
    index: number,
    field: keyof LineItem,
    value: string | number
  ) => {
    const updated = [...lineItems]
    updated[index] = { ...updated[index], [field]: value }
    setLineItems(updated)
  }

  // Validation
  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}

    if (!customerId) {
      errors.customerId = 'Customer is required'
    }

    if (!dueDate) {
      errors.dueDate = 'Due date is required'
    }

    // Validate line items
    const hasValidItems = lineItems.some(
      (item) =>
        item.description.trim() && item.quantity > 0 && item.unitPrice >= 0
    )

    if (!hasValidItems) {
      errors.lineItems = 'At least one valid line item is required'
    }

    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  // Close handler
  const handleClose = () => {
    setFormErrors({})
    setFormSubmitted(false)
    onClose?.()
    onOpenChange?.(false)
  }

  // Submit handler
  const handleSubmit = async (
    e: React.FormEvent,
    saveAs: 'draft' | 'issued' = 'draft'
  ) => {
    e.preventDefault()
    setFormSubmitted(true)

    if (!validateForm()) {
      return
    }

    // Filter valid line items
    const validItems: InvoiceLineItemPayload[] = lineItems
      .filter((item) => item.description.trim() && item.quantity > 0)
      .map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        type: item.type,
      }))

    if (mode === 'create') {
      const payload: CreateInvoicePayload = {
        customerId,
        subscriptionId: subscriptionId || undefined,
        invoiceDate,
        dueDate,
        taxAmount,
        discountAmount,
        memo: memo || undefined,
        status: saveAs,
        items: validItems,
      }

      createInvoice(payload, {
        onSuccess: (newInvoice) => {
          handleClose()
          onSuccess?.(newInvoice as unknown as Invoice)
          router.push(`/invoices/${newInvoice.id}`)
        },
      })
    } else if (mode === 'edit' && invoice) {
      const payload: UpdateInvoicePayload = {
        customerId,
        invoiceDate,
        dueDate,
        taxAmount,
        discountAmount,
        memo: memo || undefined,
        items: validItems,
      }

      updateInvoice(
        { invoiceId: invoice.id, payload },
        {
          onSuccess: (updatedInvoice) => {
            handleClose()
            onSuccess?.(updatedInvoice as unknown as Invoice)
          },
        }
      )
    }
  }

  const isSubmitting = isCreating || isUpdating

  if (!isOpen) return null

  return (
    <div className='fixed inset-0 z-50 flex'>
      <div className='fixed inset-0 bg-black/20' onClick={handleClose} />
      <div className='fixed right-0 top-0 flex h-full w-full max-w-2xl flex-col bg-background shadow-lg'>
        {/* Header */}
        <div className='flex items-center justify-between border-b p-4'>
          <h2 className='text-lg font-semibold'>
            {mode === 'create' ? 'Create Invoice' : 'Edit Invoice'}
          </h2>
          <Button variant='ghost' size='icon' onClick={handleClose}>
            <XIcon className='h-4 w-4' />
          </Button>
        </div>

        {/* Form */}
        <form
          onSubmit={(e) => handleSubmit(e, 'draft')}
          className='flex h-full flex-col'
        >
          <div className='flex-1 overflow-y-auto'>
            <div className='space-y-6 p-6'>
              {/* Customer Selection */}
              <div className='grid gap-4 md:grid-cols-2'>
                <div>
                  <Label htmlFor='customerId'>Customer *</Label>
                  <Select
                    value={customerId}
                    onValueChange={(value) => {
                      setCustomerId(value)
                      setSubscriptionId(null) // Reset subscription when customer changes
                      if (formErrors.customerId) {
                        setFormErrors({ ...formErrors, customerId: '' })
                      }
                    }}
                    disabled={mode === 'edit'}
                  >
                    <SelectTrigger
                      className={
                        formSubmitted && formErrors.customerId
                          ? 'border-red-500'
                          : ''
                      }
                    >
                      <SelectValue placeholder='Select a customer' />
                    </SelectTrigger>
                    <SelectContent>
                      {customers.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id}>
                          {customer.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {formSubmitted && formErrors.customerId && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.customerId}
                    </p>
                  )}
                </div>

                {/* Subscription Selection (Optional) */}
                <div>
                  <Label htmlFor='subscriptionId'>
                    Subscription (Optional)
                  </Label>
                  <Select
                    value={subscriptionId || 'none'}
                    onValueChange={(value) =>
                      setSubscriptionId(value === 'none' ? null : value)
                    }
                    disabled={!customerId || mode === 'edit'}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          customerId
                            ? 'Select a subscription'
                            : 'Select customer first'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='none'>No subscription</SelectItem>
                      {customerSubscriptions.map((sub) => (
                        <SelectItem key={sub.id} value={sub.id}>
                          {sub.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Dates */}
              <div className='grid gap-4 md:grid-cols-2'>
                <div>
                  <Label htmlFor='invoiceDate'>Invoice Date</Label>
                  <Input
                    id='invoiceDate'
                    type='date'
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor='dueDate'>Due Date *</Label>
                  <Input
                    id='dueDate'
                    type='date'
                    value={dueDate}
                    onChange={(e) => {
                      setDueDate(e.target.value)
                      if (formErrors.dueDate) {
                        setFormErrors({ ...formErrors, dueDate: '' })
                      }
                    }}
                    className={
                      formSubmitted && formErrors.dueDate
                        ? 'border-red-500'
                        : ''
                    }
                  />
                  {formSubmitted && formErrors.dueDate && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.dueDate}
                    </p>
                  )}
                </div>
              </div>

              {/* Line Items */}
              <div>
                <div className='mb-2 flex items-center justify-between'>
                  <Label>Line Items *</Label>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={addLineItem}
                  >
                    <PlusIcon className='mr-1 h-4 w-4' />
                    Add Item
                  </Button>
                </div>

                {formSubmitted && formErrors.lineItems && (
                  <p className='mb-2 text-xs text-red-500'>
                    {formErrors.lineItems}
                  </p>
                )}

                <div className='space-y-3'>
                  {/* Header */}
                  <div className='grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground'>
                    <div className='col-span-5'>Description</div>
                    <div className='col-span-2'>Qty</div>
                    <div className='col-span-2'>Unit Price</div>
                    <div className='col-span-2 text-right'>Amount</div>
                    <div className='col-span-1'></div>
                  </div>

                  {/* Items */}
                  {lineItems.map((item, index) => (
                    <div key={index} className='grid grid-cols-12 gap-2'>
                      <div className='col-span-5'>
                        <Input
                          placeholder='Item description'
                          value={item.description}
                          onChange={(e) =>
                            updateLineItem(index, 'description', e.target.value)
                          }
                        />
                      </div>
                      <div className='col-span-2'>
                        <Input
                          type='number'
                          min='0'
                          step='1'
                          value={item.quantity}
                          onChange={(e) =>
                            updateLineItem(
                              index,
                              'quantity',
                              parseFloat(e.target.value) || 0
                            )
                          }
                        />
                      </div>
                      <div className='col-span-2'>
                        <Input
                          type='number'
                          min='0'
                          step='0.01'
                          value={item.unitPrice}
                          onChange={(e) =>
                            updateLineItem(
                              index,
                              'unitPrice',
                              parseFloat(e.target.value) || 0
                            )
                          }
                        />
                      </div>
                      <div className='col-span-2 flex items-center justify-end text-sm'>
                        {formatCurrency(item.quantity * item.unitPrice)}
                      </div>
                      <div className='col-span-1 flex items-center justify-center'>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          onClick={() => removeLineItem(index)}
                          disabled={lineItems.length === 1}
                          className='h-8 w-8 text-muted-foreground hover:text-destructive'
                        >
                          <TrashIcon className='h-4 w-4' />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Totals */}
              <div className='rounded-lg border bg-muted/50 p-4'>
                <div className='space-y-2'>
                  <div className='flex justify-between'>
                    <span className='text-muted-foreground'>Subtotal</span>
                    <span>{formatCurrency(subtotal)}</span>
                  </div>

                  <div className='flex items-center justify-between gap-4'>
                    <span className='text-muted-foreground'>Tax</span>
                    <Input
                      type='number'
                      min='0'
                      step='0.01'
                      value={taxAmount}
                      onChange={(e) =>
                        setTaxAmount(parseFloat(e.target.value) || 0)
                      }
                      className='w-32 text-right'
                    />
                  </div>

                  <div className='flex items-center justify-between gap-4'>
                    <span className='text-muted-foreground'>Discount</span>
                    <Input
                      type='number'
                      min='0'
                      step='0.01'
                      value={discountAmount}
                      onChange={(e) =>
                        setDiscountAmount(parseFloat(e.target.value) || 0)
                      }
                      className='w-32 text-right'
                    />
                  </div>

                  <div className='border-t pt-2'>
                    <div className='flex justify-between text-lg font-semibold'>
                      <span>Total</span>
                      <span>{formatCurrency(total)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Memo */}
              <div className='pb-14'>
                <Label htmlFor='memo'>Notes / Memo</Label>
                <Textarea
                  id='memo'
                  placeholder='Optional notes for the customer...'
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  rows={3}
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className='sticky bottom-0 mt-auto border-t bg-background p-4'>
            <div className='flex gap-3'>
              <Button
                type='button'
                variant='outline'
                className='flex-1'
                onClick={handleClose}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              {mode === 'create' && (
                <>
                  <Button
                    type='submit'
                    variant='outline'
                    className='flex-1'
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    ) : null}
                    Save as Draft
                  </Button>
                  <Button
                    type='button'
                    className='flex-1'
                    disabled={isSubmitting}
                    onClick={(e) => handleSubmit(e, 'issued')}
                  >
                    {isSubmitting ? (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    ) : null}
                    Create & Finalize
                  </Button>
                </>
              )}
              {mode === 'edit' && (
                <Button
                  type='submit'
                  className='flex-1'
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                  ) : null}
                  Save Changes
                </Button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
