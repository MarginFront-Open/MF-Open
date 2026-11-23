'use client'

import { useRouter } from 'next/navigation'
import { Page } from '@/components/layouts/page'
import { CreateCustomerForm } from '@/features/customers/components/create-customer-form'

export default function NewCustomer() {
  const router = useRouter()

  return (
    <>
      <Page title="Create New Customer">
        <></>
      </Page>

      <CreateCustomerForm
        isOpen={true}
        onClose={() => router.push('/customers')}
        onSuccess={() => router.push('/customers')}
      />
    </>
  )
}
