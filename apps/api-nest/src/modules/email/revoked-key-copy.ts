/**
 * WHAT THIS FILE DOES: the PURE copy builder for the revoked-key-in-use owner
 * notice — "a key you revoked is still being sent at us". Dependency-
 * free (no Nest, no Resend, no clock beyond what the caller passes) so the
 * wording is unit-tested as literal strings, exactly like customer-alert-copy.ts.
 * CONNECTS TO: email.service.ts sendRevokedKeyInUseEmail (HTML wrap + send),
 * revoked-key-notice.service.ts (recipient resolution), and the
 * copy-style gate beside this file.
 *
 * The rule that governs every line: the key is DEAD and stays dead. The email
 * reports that something is still sending it, and points at the one fix (mint a
 * new key, swap it in) — it never implies anything else was blocked.
 */

export interface RevokedKeyNoticeCopyInput {
  /** api_keys.name — the label the owner gave the key. */
  keyLabel: string;
  revokedAt: Date;
  /** Rejected attempts observed in the current cooldown window at send time. */
  attempts: number;
}

export interface RevokedKeyNoticeContent {
  subject: string;
  headline: string;
  whatHappened: string;
  whatItMeans: string;
  whatToDo: string;
}

function formatUtcDay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function buildRevokedKeyNoticeContent(
  input: RevokedKeyNoticeCopyInput,
): RevokedKeyNoticeContent {
  const times = input.attempts === 1 ? '1 time' : `${input.attempts} times`;
  return {
    subject: 'A revoked API key is still being used',
    headline: 'A revoked key is still in use',
    whatHappened:
      `The key "${input.keyLabel}" was revoked on ${formatUtcDay(input.revokedAt)}. ` +
      `Something is still sending it to the API. We've turned it away ${times} so far.`,
    whatItMeans:
      "Whatever sends that key isn't getting through. If it's one of your " +
      "services, its usage isn't being recorded.",
    whatToDo:
      'Create a new key in Build > API keys, then update the app or service that ' +
      'still uses the old one.',
  };
}
