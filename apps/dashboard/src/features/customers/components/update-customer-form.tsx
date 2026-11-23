import { useState } from 'react'
import {
  Customer,
  UpdateCustomerPayload,
  useUpdateCustomer,
} from '@/services/customers-service'
import { X } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

interface UpdateCustomerFormProps {
  customer: Customer
  isOpen: boolean
  onClose?: () => void
  onOpenChange?: (open: boolean) => void
  onSuccess?: () => void
}

export function UpdateCustomerForm({
  customer,
  isOpen,
  onClose,
  onOpenChange,
  onSuccess,
}: UpdateCustomerFormProps) {
  const { mutate: updateCustomer, isPending: isLoading } = useUpdateCustomer(
    customer.id
  )
  const [formData, setFormData] = useState<UpdateCustomerPayload>({
    externalId: customer.externalId || '',
    name: customer.name || '',
    email: customer.email || '',
    phone: customer.phone || '',
    addressLine1: customer.addressLine1 || '',
    addressLine2: customer.addressLine2 || '',
    city: customer.city || '',
    state: customer.state || '',
    zipCode: customer.zipCode || '',
    country: customer.country || '',
  })

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData({
      ...formData,
      [name]: value,
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    updateCustomer(formData, {
      onSuccess: () => {
        toast({
          title: 'Success',
          description: 'Customer updated successfully',
        })

        if (onSuccess) {
          onSuccess()
        }

        handleClose()
      },
      onError: (error) => {
        console.error('Error updating customer:', error)
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to update customer',
        })
      },
    })
  }

  const handleClose = () => {
    if (onClose) {
      onClose()
    }
    if (onOpenChange) {
      onOpenChange(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className='fixed inset-0 z-50 flex'>
      <div className='fixed inset-0 bg-black/20' onClick={handleClose} />
      <div className='fixed right-0 top-0 flex h-full w-full max-w-md flex-col bg-background shadow-lg'>
        <div className='flex items-center justify-between border-b p-4'>
          <h2 className='text-lg font-semibold'>Update Customer</h2>
          <Button variant='ghost' size='icon' onClick={handleClose}>
            <X className='h-4 w-4' />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className='flex h-full flex-col'>
          <div className='flex-1 overflow-y-auto'>
            <div className='space-y-6 p-6'>
              <div>
                <Label htmlFor='externalId' className='flex items-center gap-1'>
                  External ID
                  <InfoTooltip {...tooltipDefinitions.externalId} />
                </Label>
                <Input
                  id='externalId'
                  name='externalId'
                  value={formData.externalId}
                  onChange={handleInputChange}
                  placeholder='Enter external ID'
                />
              </div>

              <div>
                <Label htmlFor='name'>Name</Label>
                <Input
                  id='name'
                  name='name'
                  value={formData.name}
                  onChange={handleInputChange}
                  placeholder='Enter name'
                  required
                />
              </div>

              <div>
                <Label htmlFor='email'>Email</Label>
                <Input
                  id='email'
                  name='email'
                  type='email'
                  value={formData.email}
                  onChange={handleInputChange}
                  placeholder='Enter email (optional)'
                />
              </div>

              <div>
                <Label htmlFor='phone'>Phone</Label>
                <Input
                  id='phone'
                  name='phone'
                  value={formData.phone}
                  onChange={handleInputChange}
                  placeholder='Enter phone'
                />
              </div>

              <div className='pt-4'>
                <h3 className='mb-4 text-base font-medium'>
                  Address Information
                </h3>

                <div className='space-y-4'>
                  <div>
                    <Label htmlFor='addressLine1'>Address Line 1</Label>
                    <Input
                      id='addressLine1'
                      name='addressLine1'
                      value={formData.addressLine1}
                      onChange={handleInputChange}
                      placeholder='Street address'
                    />
                  </div>

                  <div>
                    <Label htmlFor='addressLine2'>Address Line 2</Label>
                    <Input
                      id='addressLine2'
                      name='addressLine2'
                      value={formData.addressLine2}
                      onChange={handleInputChange}
                      placeholder='Apt, Suite, Unit, etc. (optional)'
                    />
                  </div>

                  <div className='grid grid-cols-2 gap-4'>
                    <div>
                      <Label htmlFor='city'>City</Label>
                      <Input
                        id='city'
                        name='city'
                        value={formData.city}
                        onChange={handleInputChange}
                        placeholder='City'
                      />
                    </div>
                    <div>
                      <Label htmlFor='state'>State</Label>
                      <Input
                        id='state'
                        name='state'
                        value={formData.state}
                        onChange={handleInputChange}
                        placeholder='State'
                      />
                    </div>
                  </div>

                  <div>
                    <Label htmlFor='zipCode'>ZIP Code</Label>
                    <Input
                      id='zipCode'
                      name='zipCode'
                      value={formData.zipCode}
                      onChange={handleInputChange}
                      placeholder='ZIP code'
                    />
                  </div>

                  <div className='pb-14'>
                    <Label htmlFor='country'>Country</Label>
                    <Input
                      id='country'
                      name='country'
                      value={formData.country}
                      onChange={handleInputChange}
                      placeholder='Country'
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className='sticky bottom-0 mt-auto border-t bg-background p-4'>
            <Button type='submit' className='w-full' disabled={isLoading}>
              {isLoading ? 'Updating...' : 'Submit'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
