'use client'

/**
 * The create-key-pair flow (form + ONE-TIME REVEAL), shared with the Build
 * API-keys tab. This is the ONLY place a full
 * mf_sk_ secret ever exists in the browser: getApiKeys() masks it on every
 * read after creation, so closing the sheet clears the revealed pair and
 * there is deliberately no second copy of this markup anywhere.
 */

import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CopyIcon,
  KeyRound,
  Loader2,
  Globe,
  Shield,
  Sparkles,
} from 'lucide-react'
import type { KeyRole } from '@marginfront/db'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import { useCurrentOrganization } from '@/hooks/use-auth'
import {
  useCreateApiKeyPair,
  type ApiKeyPairResponse,
  type CreateApiKeyParams,
} from '@/services/api-keys-service'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
  KEY_ROLE_DETAIL_LINES,
  KEY_ROLE_LABELS,
  KEY_ROLE_ORDER,
  KEY_ROLE_TEACHING_COPY,
  defaultMintRole,
  mintableKeyRoles,
  unavailableRoleReason,
} from './key-role-display'

export interface CreateKeyPairSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateKeyPairSheet({
  open,
  onOpenChange,
}: CreateKeyPairSheetProps) {
  const { toast } = useToast()
  const { organization } = useCurrentOrganization()
  const [newKeyPair, setNewKeyPair] = useState<CreateApiKeyParams>({
    name: '',
    description: '',
  })
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null)
  // The role ceiling for the secret half of this pair — the SAME set the
  // server enforces via mintableKeyRoles.
  const mintableRoles = useMemo(
    () => mintableKeyRoles(organization?.role ?? ''),
    [organization?.role]
  )
  // null = the user hasn't picked a role yet, so selectedRole tracks the
  // default as organization loads instead of freezing at an empty ceiling.
  const [pickedRole, setPickedRole] = useState<KeyRole | null>(null)
  const selectedRole = pickedRole ?? defaultMintRole(mintableRoles)
  // Holds the freshly-minted pair so we can reveal the FULL secret + publishable
  // keys exactly once, right after creation. After this, getApiKeys() masks the
  // secret on every read, so this is the ONLY moment a usable secret key exists
  // in the browser. null = nothing to reveal (show the create form instead).
  const [createdPair, setCreatedPair] = useState<ApiKeyPairResponse | null>(
    null
  )

  const createKeyPairMutation = useCreateApiKeyPair()

  const handleCreateKeyPair = () => {
    if (
      !newKeyPair.name.trim() ||
      !selectedRole ||
      createKeyPairMutation.isPending
    )
      return

    createKeyPairMutation.mutate(
      { ...newKeyPair, role: selectedRole },
      {
        onSuccess: (data) => {
          // DON'T close the sheet here. Closing before the customer copies
          // the secret throws away the only copy they'll ever get. Instead,
          // swap the form for a one-time reveal of the full keys.
          if (data) setCreatedPair(data)
          setNewKeyPair({ name: '', description: '' })
        },
      }
    )
  }

  // Close the create sheet and clear the revealed keys so the next open starts
  // fresh on the form (and the full secret never lingers in component state).
  const closeCreateSheet = () => {
    onOpenChange(false)
    setCreatedPair(null)
    setPickedRole(null)
  }

  const copyToClipboard = (text: string, keyId: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedKeyId(keyId)
        toast({
          title: 'Copied to clipboard',
          description: 'API key has been copied to your clipboard.',
          duration: 2000,
        })
        setTimeout(() => setCopiedKeyId(null), 2000)
      })
      .catch((err) => {
        console.error('Failed to copy: ', err)
        toast({
          title: 'Failed to copy',
          description: 'Could not copy the API key to clipboard.',
          variant: 'destructive',
        })
      })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) =>
        nextOpen ? onOpenChange(true) : closeCreateSheet()
      }
    >
      <SheetContent side='right' className='overflow-y-auto sm:max-w-md'>
        <SheetHeader className='pb-4'>
          <div className='flex items-center gap-3'>
            <div className='flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10'>
              <KeyRound className='h-5 w-5 text-primary' />
            </div>
            <div>
              <SheetTitle className='text-foreground'>
                Create API Key Pair
              </SheetTitle>
              <SheetDescription>
                Generate both secret and publishable keys
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className='space-y-5 py-4'>
          {createdPair ? (
            <>
              {/* ===== ONE-TIME REVEAL — the only place the full secret exists ===== */}
              <Card className='border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'>
                <CardContent className='flex items-start gap-2 px-3 py-3'>
                  <CheckCircle2 className='mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-500' />
                  <p className='text-xs text-emerald-800 dark:text-emerald-200'>
                    <strong>Key pair created.</strong> Copy your secret key now
                    and store it somewhere safe, like a password manager or your
                    server&apos;s environment variables.
                  </p>
                </CardContent>
              </Card>

              {/* Secret key — full value, shown ONLY here, ONLY once */}
              <div className='space-y-1.5'>
                <div className='flex items-center gap-2'>
                  <Shield className='h-3.5 w-3.5 text-amber-600' />
                  <Label className='text-foreground'>Secret key</Label>
                  <Badge className='bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'>
                    mf_sk_*
                  </Badge>
                </div>
                <div className='flex items-center gap-2 rounded-lg border border-amber-200/60 bg-muted/50 px-3 py-2.5'>
                  {/* sentry-mask: this secret renders as TEXT, not an input,
                      so session replay's input masking never covers it, and an
                      operator may turn text masking off. */}
                  <code className='sentry-mask flex-1 break-all font-mono text-xs text-foreground'>
                    {createdPair.secretKey.apiKeyPlaintext}
                  </code>
                  <Button
                    variant='ghost'
                    size='sm'
                    className={cn(
                      'h-7 w-7 flex-shrink-0 p-0',
                      copiedKeyId === createdPair.secretKey.id
                        ? 'text-emerald-600'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() =>
                      copyToClipboard(
                        createdPair.secretKey.apiKeyPlaintext,
                        createdPair.secretKey.id
                      )
                    }
                  >
                    {copiedKeyId === createdPair.secretKey.id ? (
                      <CheckCircle2 className='h-3.5 w-3.5' />
                    ) : (
                      <CopyIcon className='h-3.5 w-3.5' />
                    )}
                  </Button>
                </div>
              </div>

              {/* Publishable key — full value (frontend-safe) */}
              <div className='space-y-1.5'>
                <div className='flex items-center gap-2'>
                  <Globe className='h-3.5 w-3.5 text-emerald-600' />
                  <Label className='text-foreground'>Publishable key</Label>
                  <Badge className='bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'>
                    mf_pk_*
                  </Badge>
                </div>
                <div className='flex items-center gap-2 rounded-lg border border-emerald-200/60 bg-muted/50 px-3 py-2.5'>
                  {/* Masked despite the name: mf_pk_ is capped on write METHODS
                      only (PublishableKeyWriteGuardInterceptor), with no read
                      allowlist — it can GET this org's customers and invoices. */}
                  <code className='sentry-mask flex-1 break-all font-mono text-xs text-foreground'>
                    {createdPair.publishableKey.apiKeyPlaintext}
                  </code>
                  <Button
                    variant='ghost'
                    size='sm'
                    className={cn(
                      'h-7 w-7 flex-shrink-0 p-0',
                      copiedKeyId === createdPair.publishableKey.id
                        ? 'text-emerald-600'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() =>
                      copyToClipboard(
                        createdPair.publishableKey.apiKeyPlaintext,
                        createdPair.publishableKey.id
                      )
                    }
                  >
                    {copiedKeyId === createdPair.publishableKey.id ? (
                      <CheckCircle2 className='h-3.5 w-3.5' />
                    ) : (
                      <CopyIcon className='h-3.5 w-3.5' />
                    )}
                  </Button>
                </div>
              </div>

              {/* The hard truth, stated plainly */}
              <Card className='border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'>
                <CardContent className='flex items-start gap-2 px-3 py-3'>
                  <AlertTriangle className='mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500' />
                  <p className='text-xs text-amber-800 dark:text-amber-200'>
                    This is the only time we&apos;ll show your secret key. We
                    can&apos;t show it again. If you lose it, create a new key
                    pair and revoke this one.
                  </p>
                </CardContent>
              </Card>

              <SheetFooter className='pt-2'>
                <Button
                  onClick={closeCreateSheet}
                  className='w-full bg-primary hover:bg-primary/90'
                >
                  <CheckCircle2 className='mr-2 h-4 w-4' />
                  I&apos;ve saved my secret key
                </Button>
              </SheetFooter>
            </>
          ) : (
            <>
              {/* Key Name */}
              <div className='space-y-2'>
                <Label htmlFor='key-name' className='text-foreground'>
                  Key Name <span className='text-destructive'>*</span>
                </Label>
                <Input
                  id='key-name'
                  value={newKeyPair.name}
                  onChange={(e) =>
                    setNewKeyPair({ ...newKeyPair, name: e.target.value })
                  }
                  placeholder='e.g. Production, Development, My App'
                  className='border-border focus:border-primary'
                />
                <p className='text-xs text-muted-foreground'>
                  We&apos;ll create two keys: &quot;
                  {newKeyPair.name || 'Name'} (Secret)&quot; and &quot;
                  {newKeyPair.name || 'Name'} (Publishable)&quot;
                </p>
              </div>

              {/* Description */}
              <div className='space-y-2'>
                <Label htmlFor='description' className='text-foreground'>
                  Description (optional)
                </Label>
                <Textarea
                  id='description'
                  value={newKeyPair.description}
                  onChange={(e) =>
                    setNewKeyPair({
                      ...newKeyPair,
                      description: e.target.value,
                    })
                  }
                  placeholder='What will these keys be used for?'
                  className='min-h-20 border-border focus:border-primary'
                />
              </div>

              {/* Key role: the creation flow
                  must teach the difference at mint time, and grayed-out roles
                  must say WHY they're unavailable. This IS the secret key's
                  role; the publishable half always gets Member (read-only),
                  regardless of what you pick here. */}
              <div className='space-y-2'>
                <Label className='text-foreground'>Secret key role</Label>
                <p className='text-xs text-muted-foreground'>
                  A Developer key can generate usage but can never touch
                  invoices or payouts, and a Finance key is the reverse. Pick
                  the narrowest role that does the job.
                </p>
                <RadioGroup
                  value={selectedRole ?? undefined}
                  onValueChange={(value) => setPickedRole(value as KeyRole)}
                  className='gap-2'
                >
                  {KEY_ROLE_ORDER.map((roleOption) => {
                    const reason = unavailableRoleReason(
                      roleOption,
                      organization?.role
                    )
                    const isUnavailable = reason !== null
                    return (
                      <label
                        key={roleOption}
                        htmlFor={`key-role-${roleOption}`}
                        className={cn(
                          'flex items-start gap-2 rounded-lg border px-3 py-2 transition-colors',
                          isUnavailable
                            ? 'cursor-not-allowed border-border/60 bg-muted/30 opacity-60'
                            : 'cursor-pointer border-border hover:border-primary/40'
                        )}
                      >
                        <RadioGroupItem
                          id={`key-role-${roleOption}`}
                          value={roleOption}
                          disabled={isUnavailable}
                          className='mt-0.5'
                        />
                        <span className='flex flex-col'>
                          <span className='text-sm font-medium text-foreground'>
                            {KEY_ROLE_LABELS[roleOption]}
                          </span>
                          <span className='text-xs text-muted-foreground'>
                            {isUnavailable
                              ? reason
                              : KEY_ROLE_TEACHING_COPY[roleOption]}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </RadioGroup>

                {/* The consequences of the SELECTED role. They live
                    here and not in the option label because all six labels
                    render at once, so a paragraph in one of them buries the
                    other five. Only Ingest-only has an entry, and it is the
                    default selection, so every minter reads it. */}
                {selectedRole && KEY_ROLE_DETAIL_LINES[selectedRole] ? (
                  <Card className='border-border bg-muted/30'>
                    <CardContent className='px-4 py-3'>
                      <p className='mb-2 text-xs font-medium text-foreground'>
                        {KEY_ROLE_LABELS[selectedRole]}: what that means
                      </p>
                      <ul className='space-y-1.5'>
                        {KEY_ROLE_DETAIL_LINES[selectedRole]?.map((line) => (
                          <li
                            key={line}
                            className='text-xs text-muted-foreground'
                          >
                            {line}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                ) : null}
              </div>

              {/* What You'll Get */}
              <Card className='border-primary/20 bg-primary/5'>
                <CardContent className='px-4 py-3'>
                  <p className='mb-2 text-xs font-medium text-foreground'>
                    You&apos;ll receive:
                  </p>
                  <div className='space-y-2'>
                    <div className='flex items-center gap-2'>
                      <Shield className='h-3.5 w-3.5 text-amber-600' />
                      <code className='rounded bg-amber-100 px-1.5 py-0.5 text-xs dark:bg-amber-900/30'>
                        mf_sk_xxx
                      </code>
                      <span className='text-xs text-muted-foreground'>
                        : Secret
                      </span>
                    </div>
                    <div className='flex items-center gap-2'>
                      <Globe className='h-3.5 w-3.5 text-emerald-600' />
                      <code className='rounded bg-emerald-100 px-1.5 py-0.5 text-xs dark:bg-emerald-900/30'>
                        mf_pk_xxx
                      </code>
                      <span className='text-xs text-muted-foreground'>
                        : Publishable
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Security Warning */}
              <Card className='border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'>
                <CardContent className='flex items-start gap-2 px-3 py-3'>
                  <AlertTriangle className='mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500' />
                  <p className='text-xs text-amber-800 dark:text-amber-200'>
                    <strong>Important:</strong> Copy your secret key immediately
                    after creation. For security, it will only be displayed
                    once.
                  </p>
                </CardContent>
              </Card>

              <SheetFooter className='pt-2'>
                <Button
                  onClick={handleCreateKeyPair}
                  disabled={
                    !newKeyPair.name.trim() ||
                    !selectedRole ||
                    createKeyPairMutation.isPending
                  }
                  className='w-full bg-primary hover:bg-primary/90'
                >
                  {createKeyPairMutation.isPending ? (
                    <>
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                      Creating...
                    </>
                  ) : (
                    <>
                      <Sparkles className='mr-2 h-4 w-4' />
                      Create Key Pair
                    </>
                  )}
                </Button>
              </SheetFooter>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
