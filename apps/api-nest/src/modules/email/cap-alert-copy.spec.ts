/**
 * The honest-copy proofs for ladder alerts.
 *
 * These pin the copy rules as LITERAL strings so a future edit that
 * blurs "alert" and "block" fails CI, not a customer's trust:
 *   - Track 100% must say "this is a notification, not a stop".
 *   - Enforce 100% must say what is now blocked (the cap sentence) AND the raise
 *     path, with the authority DERIVED from CAP_MANAGE_ROLES (never hardcoded).
 *   - 50/80 rungs are a plain heads-up with pace framing.
 *   - Track-mode copy never claims it stops/blocks/prevents/halts work — the
 *     ONLY sanctioned "stop" is the disclaimer "not a stop" (mirrors MODE_COPY in
 *     the dashboard's spend-controls-utils).
 */

import { CAP_MANAGE_ROLES } from '@marginfront/db';
import { buildCapAlertContent, CapAlertCopyInput } from './cap-alert-copy';

const base: Omit<CapAlertCopyInput, 'mode' | 'rung' | 'percentOfCap' | 'spentUsd'> = {
  scope: 'org',
  scopeValue: null,
  providerScope: 'all',
  amountUsd: 200,
  period: 'week',
  asOf: new Date('2026-07-22T09:00:00.000Z'),
};

const content = (over: Partial<CapAlertCopyInput> & Pick<CapAlertCopyInput, 'mode' | 'rung'>) =>
  buildCapAlertContent({
    ...base,
    spentUsd: (base.amountUsd * over.rung) / 100,
    percentOfCap: over.rung,
    ...over,
  });

const allText = (c: ReturnType<typeof buildCapAlertContent>) =>
  `${c.subject} ${c.headline} ${c.capSentence} ${c.whatHappened} ${c.whatItMeans} ${c.whatToDo}`;

describe('buildCapAlertContent — track mode never blurs alert vs block', () => {
  it('track 100% says it is a notification, not a stop', () => {
    const c = content({ mode: 'track', rung: 100 });
    expect(allText(c).toLowerCase()).toContain('this is a notification, not a stop');
  });

  it('track copy contains no stop/block/prevent/halt language (beyond the sanctioned disclaimer)', () => {
    for (const rung of [50, 80, 100]) {
      const c = content({ mode: 'track', rung });
      // Strip the one sanctioned "stop" (the disclaimer) before checking the residue.
      const residue = allText(c).toLowerCase().split('not a stop').join('');
      expect(residue).not.toContain('stop');
      expect(residue).not.toContain('block');
      expect(residue).not.toContain('prevent');
      expect(residue).not.toContain('halt');
    }
  });

  it('50/80 rungs are a heads-up that names the spend and the cap', () => {
    const c = content({ mode: 'track', rung: 80, spentUsd: 160, percentOfCap: 80 });
    expect(c.whatHappened).toContain('$160');
    expect(c.whatHappened).toContain('$200');
    // No "reached"/stop framing on a mid-ladder rung.
    expect(c.whatItMeans.toLowerCase()).not.toContain('stop');
  });
});

describe('buildCapAlertContent — enforce mode names the block and the raise path', () => {
  it('enforce 100% states what is now blocked (the cap sentence)', () => {
    const c = content({ mode: 'enforce', rung: 100 });
    // The plain cap sentence for an enforce cap leads with "Stop".
    expect(c.capSentence).toContain('Stop');
    expect(c.capSentence).toContain('$200');
    expect(allText(c).toLowerCase()).toContain('blocked');
  });

  it('enforce 100% names the raise path, with the authority derived from CAP_MANAGE_ROLES', () => {
    const c = content({ mode: 'enforce', rung: 100 });
    const text = allText(c).toLowerCase();
    expect(text).toContain('to raise it');
    // DERIVED, not hardcoded: every role in the canonical set appears in the copy.
    for (const role of CAP_MANAGE_ROLES) {
      expect(text).toContain(role);
    }
  });

  it('enforce 50/80 uses pace framing toward the stop (stop language is allowed here)', () => {
    const c = content({ mode: 'enforce', rung: 50 });
    expect(c.whatItMeans.toLowerCase()).toContain('100%');
    expect(c.whatItMeans.toLowerCase()).toContain('stop');
  });
});

describe('buildCapAlertContent — the cap named as a plain sentence', () => {
  it('track cap sentence never says stop; enforce cap sentence does', () => {
    expect(content({ mode: 'track', rung: 100 }).capSentence.toLowerCase()).not.toContain('stop');
    expect(content({ mode: 'enforce', rung: 100 }).capSentence.toLowerCase()).toContain('stop');
  });

  it('a dev-scoped cap names the developer in the sentence', () => {
    const c = content({ mode: 'track', rung: 50, scope: 'dev', scopeValue: 'dev@co.example' });
    expect(c.capSentence).toContain('dev@co.example');
  });
});

// The email's PAGE_LABEL must match the
// dashboard's Internal AI Spend page title, or the alert directs users to a
// page name that doesn't exist. The two literals live in different apps,
// so this pins each source directly (no shared import across the app
// boundary). The dashboard side is the page's exported title constant, the
// same string PageShell renders as the page header.
describe('PAGE_LABEL matches the dashboard Internal AI Spend page title', () => {
  it("both apps say 'Internal AI Spend'", () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const capSrc = readFileSync(join(__dirname, 'cap-alert-copy.ts'), 'utf8');
    const pageSrc = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'dashboard',
        'src',
        'features',
        'internal-ai-spend',
        'index.tsx',
      ),
      'utf8',
    );
    const emailLabel = capSrc.match(/const PAGE_LABEL = '([^']+)'/)?.[1];
    const dashboardLabel = pageSrc.match(/const INTERNAL_AI_SPEND_PAGE_TITLE = '([^']+)'/)?.[1];
    expect(emailLabel).toBe('Internal AI Spend');
    expect(dashboardLabel).toBe('Internal AI Spend');
    expect(emailLabel).toBe(dashboardLabel);
  });
});
