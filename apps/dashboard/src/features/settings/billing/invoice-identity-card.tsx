'use client'

import { useEffect, useState } from 'react'
import { IconBuilding } from '@tabler/icons-react'
import {
  getOrgBillingIdentity,
  saveOrgBillingIdentity,
} from '@/app/actions/org-billing-identity'
import type { OrgBillingIdentity } from '@/features/invoices/billing-identity-display'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'

type FormValues = Required<{ [K in keyof OrgBillingIdentity]: string }>

const EMPTY_FORM: FormValues = {
  legalName: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  email: '',
}

const FIELDS: Array<{
  key: keyof FormValues
  label: string
  placeholder?: string
  helper?: string
}> = [
  { key: 'legalName', label: 'Legal name' },
  { key: 'addressLine1', label: 'Address line 1' },
  { key: 'addressLine2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State or region' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'country', label: 'Country' },
  {
    key: 'email',
    label: 'Billing email',
    placeholder: 'billing@yourcompany.com',
    helper:
      'Shown to your customers on invoices as the contact address, and where MarginFront sends you billing notifications.',
  },
]

export function InvoiceIdentityCard() {
  const [form, setForm] = useState<FormValues>(EMPTY_FORM)
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getOrgBillingIdentity().then((result) => {
      if (cancelled) return
      if (result.success) {
        setOrgName(result.data.orgName)
        setForm({ ...EMPTY_FORM, ...(result.data.identity ?? {}) })
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setField = (key: keyof FormValues) => (value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }))

  const handleSave = async () => {
    setSaving(true)
    const result = await saveOrgBillingIdentity(form)
    setSaving(false)
    if (result.success) {
      toast.success({
        title: 'Invoice identity saved',
        description: 'New invoice prints will show this information.',
      })
    } else {
      toast.error({
        title: "Couldn't save the invoice identity",
        description: result.error,
      })
    }
  }

  return (
    <Card interactive className='card-md border-subtle'>
      <CardHeader>
        <div className='flex items-center gap-3'>
          <div className='rounded-lg bg-primary/10 p-2'>
            <IconBuilding className='h-5 w-5 text-primary' />
          </div>
          <div>
            <CardTitle className='text-base'>Invoice identity</CardTitle>
            <CardDescription className='text-helper'>
              This is who your invoices say the bill is from
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='grid gap-4 sm:grid-cols-2'>
          {FIELDS.map(({ key, label, placeholder, helper }) => (
            <div key={key} className='space-y-1'>
              <label
                className='label-standard'
                htmlFor={`invoice-identity-${key}`}
              >
                {label}
              </label>
              <Input
                id={`invoice-identity-${key}`}
                value={form[key]}
                onChange={(event) => setField(key)(event.target.value)}
                placeholder={
                  placeholder ?? (key === 'legalName' ? orgName : undefined)
                }
                disabled={loading || saving}
              />
              {helper ? (
                <p className='text-xs text-muted-foreground'>{helper}</p>
              ) : null}
            </div>
          ))}
        </div>
        <p className='text-xs text-muted-foreground'>
          Every field is optional. Anything you leave blank stays off the
          invoice. If you leave everything blank, invoices show your
          organization name{orgName ? ` (${orgName})` : ''} and nothing else.
        </p>
        <Button size='sm' onClick={handleSave} disabled={loading || saving}>
          {saving ? 'Saving...' : 'Save invoice identity'}
        </Button>
      </CardContent>
    </Card>
  )
}
