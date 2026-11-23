/**
 * Caps cover ALL AI spend, and MarginFront has no teams — so the API refuses
 * what the UI does not offer (one enforcement path, no side doors).
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCapPolicyDto } from './create-cap-policy.dto';

function base(): Record<string, unknown> {
  return {
    scope: 'org',
    providerScope: 'all',
    amountUsd: 200,
    period: 'week',
    mode: 'track',
  };
}

async function messagesFor(patch: Record<string, unknown>): Promise<string> {
  const dto = plainToInstance(CreateCapPolicyDto, { ...base(), ...patch });
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {})).join(' | ');
}

describe('creatable cap scopes (no teams, no provider slicing)', () => {
  it('rejects a team cap with a plain-English message', async () => {
    const msg = await messagesFor({ scope: 'team', scopeValue: 'Platform' });
    expect(msg).toContain(
      "MarginFront doesn't have teams yet. Use a whole-team cap or a per-teammate cap.",
    );
  });

  it('rejects a provider-scoped cap with the same sentence the dashboard shows', async () => {
    const msg = await messagesFor({ providerScope: 'anthropic' });
    expect(msg).toContain('Caps cover all AI tools for now.');
    // The dashboard copy has no "email support" tail, so the API message has
    // none either. Dashboard and API must never disagree.
    expect(msg).not.toContain('Email support');
  });

  it('accepts org and dev caps with providerScope all', async () => {
    expect(await messagesFor({})).toBe('');
    expect(await messagesFor({ scope: 'dev', scopeValue: 'dev@co.example' })).toBe('');
  });
});
