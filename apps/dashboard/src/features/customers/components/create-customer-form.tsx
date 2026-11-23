import { useState, useRef } from 'react'
import {
  CreateCustomerPayload,
  useCreateCustomer,
} from '@/services/customers-service'
import { XIcon, ChevronDown } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

interface CreateCustomerFormProps {
  isOpen: boolean
  onClose?: () => void
  onOpenChange?: (open: boolean) => void
  onSuccess?: () => void
}

export function CreateCustomerForm({
  isOpen,
  onClose,
  onOpenChange,
  onSuccess,
}: CreateCustomerFormProps) {
  const { mutate: createCustomer, isPending: isCreating } = useCreateCustomer()
  // isPending hasn't flushed when two clicks land in the same JS tick, so
  // disabled={isCreating} alone lets both through. This ref is synchronous.
  const submittingRef = useRef(false)

  const [formData, setFormData] = useState<CreateCustomerPayload>({
    externalId: '',
    name: '',
    email: '',
    phone: '',
    addressLine1: '',
    city: '',
    state: '',
    zipCode: '',
    country: '',
    billingContactName: '',
    billingContactEmail: '',
    metadata: {
      industry: '',
      size: '',
      region: '',
    },
  })

  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [formSubmitted, setFormSubmitted] = useState(false)
  const [billingOpen, setBillingOpen] = useState(false)

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    field: keyof CreateCustomerPayload | string
  ) => {
    const { value } = e.target

    if (formErrors[field]) {
      setFormErrors({
        ...formErrors,
        [field]: '',
      })
    }

    if (field.includes('.')) {
      const [parent, child] = field.split('.')
      if (parent === 'metadata') {
        setFormData({
          ...formData,
          metadata: {
            ...formData.metadata,
            [child]: value,
          },
        })
      }
    } else {
      setFormData({
        ...formData,
        [field]: value,
      })
    }
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}

    if (!formData.name.trim()) {
      errors.name = 'Name is required'
    }

    if (!formData.externalId?.trim()) {
      errors.externalId = 'External ID is required'
    }

    if (!formData.email?.trim()) {
      errors.email = 'Email is required'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      errors.email = 'Must be a valid email address'
    }

    // Optional billing contact email still gets validated IF provided
    if (
      formData.billingContactEmail?.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.billingContactEmail)
    ) {
      errors.billingContactEmail = 'Must be a valid email address'
    }

    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleClose = () => {
    setFormErrors({})
    setFormSubmitted(false)

    if (onClose) {
      onClose()
    }
    if (onOpenChange) {
      onOpenChange(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (submittingRef.current) return
    submittingRef.current = true

    setFormSubmitted(true)

    if (!validateForm()) {
      toast({
        variant: 'destructive',
        title: 'Validation Error',
        description: 'Please fill in all required fields',
      })
      submittingRef.current = false
      return
    }

    const submissionData: Record<string, any> = {}

    Object.keys(formData).forEach((key) => {
      const k = key as keyof CreateCustomerPayload
      const value = formData[k]

      if (k === 'name') {
        submissionData[k] = value
      } else if (typeof value === 'string' && value.trim() !== '') {
        submissionData[k] = value
      } else if (k === 'metadata' && value && typeof value === 'object') {
        const cleanedMetadata: Record<string, string> = {}
        Object.keys(value).forEach((metaKey) => {
          if (value[metaKey] && value[metaKey].trim() !== '') {
            cleanedMetadata[metaKey] = value[metaKey]
          }
        })
        if (Object.keys(cleanedMetadata).length > 0) {
          submissionData.metadata = cleanedMetadata
        }
      }
    })

    createCustomer(submissionData as CreateCustomerPayload, {
      onSettled: () => {
        submittingRef.current = false
      },
      onSuccess: () => {
        toast({
          title: 'Success',
          description: 'Customer created successfully',
        })

        setFormData({
          externalId: '',
          name: '',
          email: '',
          phone: '',
          addressLine1: '',
          city: '',
          state: '',
          zipCode: '',
          country: '',
          billingContactName: '',
          billingContactEmail: '',
          metadata: {
            industry: '',
            size: '',
            region: '',
          },
        })

        setFormErrors({})
        setFormSubmitted(false)

        if (onSuccess) {
          onSuccess()
        }

        handleClose()
      },
      onError: (error: any) => {
        console.error('Error creating customer:', error)

        let errorMessage = 'Failed to create customer'

        if (error?.response?.data?.message) {
          errorMessage = error.response.data.message
        } else if (error?.response?.data?.errors) {
          const errors = error.response.data.errors
          if (Array.isArray(errors) && errors.length > 0) {
            errorMessage = errors.map((e: any) => e.message || e).join(', ')
          }
        } else if (error?.message) {
          errorMessage = error.message
        }

        toast({
          variant: 'destructive',
          title: 'Error',
          description: errorMessage,
        })
      },
    })
  }

  if (!isOpen) return null

  return (
    <div className='fixed inset-0 z-50 flex'>
      <div className='fixed inset-0 bg-black/20' onClick={handleClose} />
      <div className='fixed right-0 top-0 flex h-full w-full max-w-md flex-col bg-background shadow-lg'>
        <div className='flex items-center justify-between border-b p-4'>
          <h2 className='text-lg font-semibold'>New Account</h2>
          <Button variant='ghost' size='icon' onClick={handleClose}>
            <XIcon className='h-4 w-4' />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className='flex h-full flex-col'>
          <div className='flex-1 overflow-y-auto'>
            <div className='space-y-6 p-6'>
              <div className='space-y-4'>
                <div>
                  <Label htmlFor='name'>Name *</Label>
                  <Input
                    id='name'
                    placeholder='Enter customer name'
                    onChange={(e) => handleInputChange(e, 'name')}
                    value={formData.name || ''}
                    maxLength={255}
                    className={
                      formSubmitted && formErrors.name ? 'border-red-500' : ''
                    }
                  />
                  {formSubmitted && formErrors.name && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.name}
                    </p>
                  )}
                </div>

                <div>
                  <Label
                    htmlFor='externalId'
                    className='flex items-center gap-1'
                  >
                    External ID *
                    <InfoTooltip {...tooltipDefinitions.externalId} />
                  </Label>
                  <Input
                    id='externalId'
                    placeholder='Your internal customer ID'
                    onChange={(e) => handleInputChange(e, 'externalId')}
                    value={formData.externalId || ''}
                    className={
                      formSubmitted && formErrors.externalId
                        ? 'border-red-500'
                        : ''
                    }
                  />
                  {formSubmitted && formErrors.externalId && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.externalId}
                    </p>
                  )}
                </div>

                <div>
                  <Label htmlFor='email'>Email *</Label>
                  <Input
                    id='email'
                    type='email'
                    placeholder='customer@example.com'
                    onChange={(e) => handleInputChange(e, 'email')}
                    value={formData.email || ''}
                    className={
                      formSubmitted && formErrors.email ? 'border-red-500' : ''
                    }
                  />
                  {formSubmitted && formErrors.email && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.email}
                    </p>
                  )}
                </div>
              </div>

              <Collapsible open={billingOpen} onOpenChange={setBillingOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    type='button'
                    className='flex w-full items-center justify-between rounded-md border px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-muted/50'
                  >
                    Billing details (optional)
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${billingOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                </CollapsibleTrigger>
                <p className='mt-1 px-1 text-xs text-muted-foreground'>
                  You can fill these in later when you&apos;re ready to send
                  invoices.
                </p>

                <CollapsibleContent className='mt-4 space-y-4'>
                  <div>
                    <Label htmlFor='phone'>Phone</Label>
                    <Input
                      id='phone'
                      placeholder='Enter phone'
                      onChange={(e) => handleInputChange(e, 'phone')}
                      value={formData.phone || ''}
                    />
                  </div>

                  <div>
                    <Label
                      htmlFor='billingContactName'
                      className='flex items-center gap-1'
                    >
                      Billing Contact Name
                      <InfoTooltip {...tooltipDefinitions.billingContact} />
                    </Label>
                    <Input
                      id='billingContactName'
                      placeholder='Enter billing contact name'
                      onChange={(e) =>
                        handleInputChange(e, 'billingContactName')
                      }
                      value={formData.billingContactName || ''}
                    />
                  </div>

                  <div>
                    <Label htmlFor='billingContactEmail'>
                      Billing Contact Email
                    </Label>
                    <Input
                      id='billingContactEmail'
                      type='email'
                      placeholder='Enter billing contact email'
                      onChange={(e) =>
                        handleInputChange(e, 'billingContactEmail')
                      }
                      value={formData.billingContactEmail || ''}
                      className={
                        formSubmitted && formErrors.billingContactEmail
                          ? 'border-red-500'
                          : ''
                      }
                    />
                    {formSubmitted && formErrors.billingContactEmail && (
                      <p className='mt-1 text-xs text-red-500'>
                        {formErrors.billingContactEmail}
                      </p>
                    )}
                  </div>

                  <div className='pt-2'>
                    <h3 className='mb-4 text-base font-medium'>Address</h3>

                    <div className='space-y-4'>
                      <div>
                        <Label htmlFor='addressLine1'>Address Line 1</Label>
                        <Input
                          id='addressLine1'
                          placeholder='Street address'
                          onChange={(e) => handleInputChange(e, 'addressLine1')}
                          value={formData.addressLine1 || ''}
                        />
                      </div>

                      <div>
                        <Label htmlFor='addressLine2'>Address Line 2</Label>
                        <Input
                          id='addressLine2'
                          placeholder='Apt, Suite, Unit, etc.'
                          onChange={(e) => handleInputChange(e, 'addressLine2')}
                          value={formData.addressLine2 || ''}
                        />
                      </div>

                      <div className='grid grid-cols-2 gap-4'>
                        <div>
                          <Label htmlFor='city'>City</Label>
                          <Input
                            id='city'
                            placeholder='City'
                            onChange={(e) => handleInputChange(e, 'city')}
                            value={formData.city || ''}
                          />
                        </div>
                        <div>
                          <Label htmlFor='state'>State</Label>
                          <Input
                            id='state'
                            placeholder='State'
                            onChange={(e) => handleInputChange(e, 'state')}
                            value={formData.state || ''}
                          />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor='zipCode'>ZIP Code</Label>
                        <Input
                          id='zipCode'
                          placeholder='ZIP code'
                          onChange={(e) => handleInputChange(e, 'zipCode')}
                          value={formData.zipCode || ''}
                        />
                      </div>

                      <div className='pb-14'>
                        <Label htmlFor='country'>Country</Label>
                        <Input
                          id='country'
                          placeholder='Country'
                          onChange={(e) => handleInputChange(e, 'country')}
                          value={formData.country || ''}
                        />
                      </div>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>

          <div className='sticky bottom-0 mt-auto border-t bg-background p-4'>
            <Button type='submit' className='w-full' disabled={isCreating}>
              {isCreating ? 'Submitting...' : 'Submit'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
