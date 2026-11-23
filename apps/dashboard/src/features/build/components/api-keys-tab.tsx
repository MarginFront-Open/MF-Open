'use client'

/**
 * API keys as a first-class Build tab. Keys are org-level, not agent-tied.
 * Full CRUD lives here, on the dev-zone service hooks (so a create
 * invalidates the same query the list reads) and the shared
 * CreateKeyPairSheet, the ONE one-time-reveal flow. /developer-zone/api-keys
 * redirects here: this tab is the one key surface.
 *
 * Write affordances sit behind canMintKeys. The gate is canMintKeys, not canManageBuild: finance
 * may reach the mint/revoke door too.
 *
 * Secret keys can NEVER be re-displayed: the key
 * cell renders the server's masked stub (or nothing) via keyCellModel, and
 * only publishable plaintext ever reaches reveal/copy.
 */

import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { AlertTriangle, Check, Copy, Eye, EyeOff } from 'lucide-react'
import {
  useApiKeys,
  useRevokeApiKey,
  type ApiKey,
} from '@/services/api-keys-service'
import { useTeamMembers } from '@/services/organization-members-service'
import { CreateKeyPairSheet } from '@/features/developer-zone/api-keys/create-key-pair-sheet'
import {
  KEY_ROLE_LABELS,
  keyRoleBadgeClassName,
  needsMinterReview,
  touchesMoney,
} from '@/features/developer-zone/api-keys/key-role-display'
import { useCurrentOrganization } from '@/hooks/use-auth'
import { useToast } from '@/hooks/use-toast'
import { canMintKeys } from '@/lib/permissions'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  TileFrame,
  type TileState,
} from '@/features/dashboard-shell/tiles/tile-frame'
import {
  KEY_STATUS_CHIPS,
  keyCellModel,
  keyTypeLabel,
  lastUsedLabel,
} from './api-key-display'

const HEADER_CELL =
  'pb-2 pt-[14px] text-left text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'

const KEYS_ERROR =
  "Couldn't load your API keys. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

export function ApiKeysTab() {
  const { toast } = useToast()
  const { organization } = useCurrentOrganization()
  // Cosmetic only — the server (assertKeyMinter) is the real enforcer.
  // Hides Create/Revoke for roles that would get a refusal toast.
  const canManage = canMintKeys(organization?.role)

  const keysQuery = useApiKeys()
  const keys = useMemo(() => keysQuery.data ?? [], [keysQuery.data])
  const revokeApiKeyMutation = useRevokeApiKey()
  // Current org roster, so a key's stamped minterRole can be compared against
  // the minter's CURRENT role (the demoted-minter review banner below).
  const { data: teamMembers } = useTeamMembers()

  const [showRetired, setShowRetired] = useState(false)
  // "Which keys can touch money" filter.
  const [moneyOnly, setMoneyOnly] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null)
  const [revealedKeyId, setRevealedKeyId] = useState<string | null>(null)
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null)

  const currentMinterRole = useMemo(() => {
    const byUserId = new Map<string, string>()
    for (const member of teamMembers ?? []) {
      byUserId.set(member.user.id, member.role)
    }
    return (minterUserId: string | null) =>
      minterUserId ? (byUserId.get(minterUserId) ?? null) : null
  }, [teamMembers])

  // Keys whose minter has since been demoted or moved lanes. The key itself
  // keeps working; this only flags it for a human to look at. Keys flagged
  // `legacy` have no minter to compare and are excluded; they get their own
  // "Full access (legacy)" badge instead.
  const keysNeedingReview = useMemo(
    () =>
      keys.filter(
        (key) =>
          key.status === 'active' &&
          !key.legacy &&
          key.minterUserId !== null &&
          needsMinterReview(key.role, currentMinterRole(key.minterUserId))
      ),
    [keys, currentMinterRole]
  )
  const reviewKeyIds = useMemo(
    () => new Set(keysNeedingReview.map((key) => key.id)),
    [keysNeedingReview]
  )

  const { visibleKeys, retiredCount } = useMemo(() => {
    const matchingKeys = moneyOnly
      ? keys.filter((key) => touchesMoney(key.role))
      : keys
    const activeKeys = matchingKeys.filter((key) => key.status === 'active')
    return {
      visibleKeys: showRetired ? matchingKeys : activeKeys,
      retiredCount: matchingKeys.length - activeKeys.length,
    }
  }, [keys, showRetired, moneyOnly])

  const state: TileState = keysQuery.isLoading
    ? 'loading'
    : keysQuery.isError
      ? 'error'
      : visibleKeys.length === 0
        ? 'empty'
        : 'ready'

  const handleCopy = (key: ApiKey, full: string) => {
    navigator.clipboard
      .writeText(full)
      .then(() => {
        setCopiedKeyId(key.id)
        setTimeout(() => setCopiedKeyId(null), 2000)
      })
      .catch(() => {
        toast({
          title: "Couldn't copy the key",
          description:
            'Your browser blocked clipboard access. Reveal the key with the eye button and copy it by hand.',
          variant: 'destructive',
        })
      })
  }

  // The hook owns the success/error toasts and the list invalidation; on
  // failure the dialog stays open for a retry.
  const handleRevokeConfirm = () => {
    if (!revokeTarget) return
    revokeApiKeyMutation.mutate(revokeTarget.id, {
      onSuccess: () => setRevokeTarget(null),
    })
  }

  return (
    <section>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        <h2 className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
          API keys
        </h2>
        <span className='text-[11px] font-medium text-mf-tx3'>
          Keys belong to your whole organization, not one agent.
        </span>
        <div className='ml-auto flex items-center gap-3'>
          <button
            type='button'
            aria-pressed={moneyOnly}
            onClick={() => setMoneyOnly((value) => !value)}
            className={`text-[11.5px] font-medium hover:text-mf-accent ${
              moneyOnly ? 'text-mf-accent' : 'text-mf-tx3'
            }`}
          >
            {moneyOnly
              ? 'Showing money-capable keys only'
              : 'Show only keys that can touch money'}
          </button>
          {retiredCount > 0 && (
            <button
              type='button'
              aria-pressed={showRetired}
              onClick={() => setShowRetired((value) => !value)}
              className='text-[11.5px] font-medium text-mf-tx3 hover:text-mf-accent'
            >
              {showRetired
                ? 'Hide revoked keys'
                : `Show revoked keys (${retiredCount})`}
            </button>
          )}
          {canManage && (
            <button
              type='button'
              onClick={() => setCreateOpen(true)}
              className='inline-flex h-7 items-center rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
            >
              ＋ Create key pair
            </button>
          )}
        </div>
      </div>

      {keysNeedingReview.length > 0 && (
        <div className='mb-3 flex items-start gap-2 rounded-mf-card border border-rose-400 bg-mf-card px-[17px] py-[10px] dark:border-rose-700'>
          <AlertTriangle className='mt-0.5 h-4 w-4 flex-shrink-0 text-rose-600 dark:text-rose-400' />
          <p className='text-[12px] text-mf-tx'>
            <strong>
              {keysNeedingReview.length} key
              {keysNeedingReview.length === 1 ? '' : 's'} need review.
            </strong>{' '}
            Whoever minted {keysNeedingReview.length === 1 ? 'it' : 'them'} no
            longer holds a role that could mint a key this powerful. The key
            {keysNeedingReview.length === 1 ? '' : 's'} still work exactly as
            before. Look for the &quot;Review&quot; tag below and decide whether
            to revoke and re-mint.
          </p>
        </div>
      )}

      <TileFrame
        state={state}
        errorMessage={KEYS_ERROR}
        emptyMessage={
          moneyOnly
            ? 'No keys can touch money. Money-capable roles are Finance, Admin, and Owner.'
            : showRetired
              ? 'No API keys yet. Create a key pair to start sending usage from your code.'
              : 'No active API keys. Create a key pair to start sending usage from your code.'
        }
        className='min-h-[120px] overflow-hidden'
        loadingLines={3}
      >
        <table className='w-full border-collapse'>
          <thead>
            <tr>
              <th className={`${HEADER_CELL} px-[17px]`}>Name</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Key</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Type</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Role</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Status</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Created</th>
              <th className={`${HEADER_CELL} px-[10px]`}>Last used</th>
              <th className={`${HEADER_CELL} px-[17px]`} aria-label='Actions' />
            </tr>
          </thead>
          <tbody>
            {visibleKeys.map((key) => {
              const cell = keyCellModel(key)
              const statusChip = KEY_STATUS_CHIPS[key.status]
              const isActiveKey = key.status === 'active'
              return (
                <tr key={key.id} className='border-t border-mf-bd2'>
                  <td className='px-[17px] py-[7px] text-[12px] font-medium text-mf-tx'>
                    {key.name}
                  </td>
                  <td className='px-[10px] py-[7px]'>
                    <span className='flex items-center gap-1'>
                      {/* sentry-mask: reveal swaps in cell.full, a live
                          publishable key. mf_pk_ is capped on WRITES only —
                          every org read is open to it. */}
                      <code className='sentry-mask font-mono text-[11.5px] text-mf-tx2'>
                        {cell.full && revealedKeyId === key.id
                          ? cell.full
                          : cell.masked}
                      </code>
                      {/* Reveal/copy only for LIVE publishable keys — a dead
                          key's value invites pasting a credential that no
                          longer authenticates. */}
                      {cell.full && isActiveKey && (
                        <>
                          <button
                            type='button'
                            aria-label={
                              revealedKeyId === key.id
                                ? `Hide ${key.name}`
                                : `Show ${key.name}`
                            }
                            onClick={() =>
                              setRevealedKeyId(
                                revealedKeyId === key.id ? null : key.id
                              )
                            }
                            className='rounded-mf-seg-item p-1 text-mf-tx3 hover:text-mf-tx'
                          >
                            {revealedKeyId === key.id ? (
                              <EyeOff className='h-3.5 w-3.5' />
                            ) : (
                              <Eye className='h-3.5 w-3.5' />
                            )}
                          </button>
                          <button
                            type='button'
                            aria-label={`Copy ${key.name}`}
                            onClick={() => handleCopy(key, cell.full!)}
                            className='rounded-mf-seg-item p-1 text-mf-tx3 hover:text-mf-tx'
                          >
                            {copiedKeyId === key.id ? (
                              <Check className='h-3.5 w-3.5 text-mf-green' />
                            ) : (
                              <Copy className='h-3.5 w-3.5' />
                            )}
                          </button>
                        </>
                      )}
                    </span>
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] text-mf-tx2'>
                    {keyTypeLabel(key.keyType)}
                  </td>
                  <td className='px-[10px] py-[7px]'>
                    <span className='flex flex-wrap items-center gap-1'>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${keyRoleBadgeClassName(key.role)}`}
                      >
                        {KEY_ROLE_LABELS[key.role]}
                      </span>
                      {key.legacy && (
                        <span className='rounded-full border border-amber-400 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:border-amber-700 dark:text-amber-400'>
                          Full access (legacy)
                        </span>
                      )}
                      {key.legacy && isActiveKey && canManage && (
                        <button
                          type='button'
                          onClick={() => setCreateOpen(true)}
                          className='text-[10.5px] font-medium text-mf-accent underline-offset-2 hover:underline'
                        >
                          Rotate to a scoped key
                        </button>
                      )}
                      {reviewKeyIds.has(key.id) && (
                        <span
                          title="Minted by someone whose role has since changed. Access hasn't changed automatically. Review and rotate if it no longer fits."
                          className='rounded-full border border-rose-400 px-2 py-0.5 text-[10.5px] font-medium text-rose-700 dark:border-rose-700 dark:text-rose-400'
                        >
                          Review
                        </span>
                      )}
                    </span>
                  </td>
                  <td className='px-[10px] py-[7px]'>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${statusChip.className}`}
                    >
                      {statusChip.label}
                    </span>
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'>
                    {format(new Date(key.createdAt), 'MMM d, yyyy')}
                  </td>
                  <td className='px-[10px] py-[7px] text-[12px] text-mf-tx2'>
                    {lastUsedLabel(key.lastUsedAt)}
                  </td>
                  <td className='px-[17px] py-[7px] text-right'>
                    {canManage && isActiveKey && (
                      <button
                        type='button'
                        onClick={() => setRevokeTarget(key)}
                        className='rounded-mf-seg-item px-1.5 py-0.5 text-[11.5px] font-medium text-red-600 hover:bg-mf-card2'
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TileFrame>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This revokes ${revokeTarget?.name ?? 'this key'}. Apps using this key stop authenticating immediately, and this can't be undone.${
                revokeTarget?.keyType === 'secret'
                  ? ' Customers signed in to your billing portal right now will be signed out and will need a fresh portal link.'
                  : ''
              } If something still needs access, create a new key pair first.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeApiKeyMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevokeConfirm}
              disabled={revokeApiKeyMutation.isPending}
            >
              {revokeApiKeyMutation.isPending ? 'Processing...' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateKeyPairSheet open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  )
}
