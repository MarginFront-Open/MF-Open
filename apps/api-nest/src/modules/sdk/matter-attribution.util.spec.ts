/**
 * WHAT THIS FILE DOES: pins the attribution precedence contract —
 * tag beats rule, unknown tags land Unassigned (never dropped, never
 * auto-created), rules match priority-asc with AND-of-set-matchers semantics,
 * and a matcherless rule fails closed.
 *
 * WHY IT EXISTS: these are the acceptance criteria for HOW an event
 * lands on a matter. The audit export prints matterSource per row; if this
 * precedence drifts, a firm's billing record silently lies about provenance.
 *
 * CONNECTS TO: matter-attribution.util.ts (under test), sdk.service.ts
 * (production caller), sdk.service.matter-attribution.spec.ts (the same
 * contract proven through the full recordUsage path).
 */

import {
  collectMatterTags,
  extractMatterTag,
  resolveMatterAttribution,
  type MatterAttributionContext,
} from './matter-attribution.util';

const MATTER_A = 'matter-a-uuid';
const MATTER_B = 'matter-b-uuid';

const baseRecord = {
  agentCode: 'intake-agent',
  customerExternalId: 'client-42',
  signalName: 'Contract Review',
};

function ctx(overrides: Partial<MatterAttributionContext> = {}): MatterAttributionContext {
  return {
    matterIdByNumber: new Map([['MAT-2214', MATTER_A]]),
    rules: [],
    ...overrides,
  };
}

describe('extractMatterTag — the metadata.matterId convention', () => {
  it('returns the trimmed string tag', () => {
    expect(extractMatterTag({ matterId: '  MAT-2214 ' })).toBe('MAT-2214');
  });

  it('treats empty, whitespace-only, non-string, and absent values as no tag', () => {
    expect(extractMatterTag({ matterId: '' })).toBeNull();
    expect(extractMatterTag({ matterId: '   ' })).toBeNull();
    expect(extractMatterTag({ matterId: 2214 })).toBeNull();
    expect(extractMatterTag({ other: 'x' })).toBeNull();
    expect(extractMatterTag(undefined)).toBeNull();
    expect(extractMatterTag(null)).toBeNull();
  });
});

describe('collectMatterTags — batch dedup for the one matters lookup', () => {
  it('dedups and skips invalid tags', () => {
    expect(
      collectMatterTags([
        { metadata: { matterId: 'MAT-2214' } },
        { metadata: { matterId: 'MAT-2214 ' } },
        { metadata: { matterId: 'ACME-1' } },
        { metadata: { matterId: 99 } },
        { metadata: {} },
        {},
      ]),
    ).toEqual(['MAT-2214', 'ACME-1']);
  });
});

describe('resolveMatterAttribution — precedence', () => {
  it('a valid tag resolves with source tag', () => {
    const result = resolveMatterAttribution(
      { ...baseRecord, metadata: { matterId: 'MAT-2214' } },
      ctx(),
    );
    expect(result).toEqual({ matterId: MATTER_A, matterSource: 'tag' });
  });

  it('a valid tag BEATS a rule that also matches', () => {
    const result = resolveMatterAttribution(
      { ...baseRecord, metadata: { matterId: 'MAT-2214' } },
      ctx({
        rules: [
          {
            matterId: MATTER_B,
            priority: 1,
            agentCode: 'intake-agent',
            customerExternalId: null,
            signalPattern: null,
          },
        ],
      }),
    );
    expect(result).toEqual({ matterId: MATTER_A, matterSource: 'tag' });
  });

  it('an UNKNOWN tag with no matching rule lands Unassigned (null, null)', () => {
    const result = resolveMatterAttribution(
      { ...baseRecord, metadata: { matterId: 'NOPE-404' } },
      ctx(),
    );
    expect(result).toEqual({ matterId: null, matterSource: null });
  });

  it('an UNKNOWN tag falls through to the rules (never auto-creates a matter)', () => {
    const result = resolveMatterAttribution(
      { ...baseRecord, metadata: { matterId: 'NOPE-404' } },
      ctx({
        rules: [
          {
            matterId: MATTER_B,
            priority: 1,
            agentCode: 'intake-agent',
            customerExternalId: null,
            signalPattern: null,
          },
        ],
      }),
    );
    expect(result).toEqual({ matterId: MATTER_B, matterSource: 'rule' });
  });

  it('an untagged record matching an agentCode rule resolves with source rule', () => {
    const result = resolveMatterAttribution(
      baseRecord,
      ctx({
        rules: [
          {
            matterId: MATTER_B,
            priority: 100,
            agentCode: 'intake-agent',
            customerExternalId: null,
            signalPattern: null,
          },
        ],
      }),
    );
    expect(result).toEqual({ matterId: MATTER_B, matterSource: 'rule' });
  });
});

describe('resolveMatterAttribution — rule matching semantics', () => {
  it('agentCode matches EXACTLY, not by substring', () => {
    const rules = [
      {
        matterId: MATTER_B,
        priority: 1,
        agentCode: 'intake',
        customerExternalId: null,
        signalPattern: null,
      },
    ];
    expect(resolveMatterAttribution(baseRecord, ctx({ rules }))).toEqual({
      matterId: null,
      matterSource: null,
    });
  });

  it('customerExternalId matches exactly', () => {
    const rules = [
      {
        matterId: MATTER_B,
        priority: 1,
        agentCode: null,
        customerExternalId: 'client-42',
        signalPattern: null,
      },
    ];
    expect(resolveMatterAttribution(baseRecord, ctx({ rules }))).toEqual({
      matterId: MATTER_B,
      matterSource: 'rule',
    });
    expect(
      resolveMatterAttribution({ ...baseRecord, customerExternalId: 'client-43' }, ctx({ rules })),
    ).toEqual({ matterId: null, matterSource: null });
  });

  it('signalPattern matches as a case-insensitive substring', () => {
    const rules = [
      {
        matterId: MATTER_B,
        priority: 1,
        agentCode: null,
        customerExternalId: null,
        signalPattern: 'contract',
      },
    ];
    expect(resolveMatterAttribution(baseRecord, ctx({ rules }))).toEqual({
      matterId: MATTER_B,
      matterSource: 'rule',
    });
  });

  it('EVERY set matcher must match (AND semantics)', () => {
    const rules = [
      {
        matterId: MATTER_B,
        priority: 1,
        agentCode: 'intake-agent',
        customerExternalId: null,
        signalPattern: 'billing', // record's signal is 'Contract Review'
      },
    ];
    expect(resolveMatterAttribution(baseRecord, ctx({ rules }))).toEqual({
      matterId: null,
      matterSource: null,
    });
  });

  it('the FIRST rule in context order wins — the resolver trusts the loader sort', () => {
    // The loader delivers rules ORDER BY priority asc, createdAt asc, id asc;
    // the resolver deliberately does NOT re-sort (one sort per batch, not per
    // record, and one place to own the tie-break).
    const rules = [
      {
        matterId: MATTER_B,
        priority: 10,
        agentCode: 'intake-agent',
        customerExternalId: null,
        signalPattern: null,
      },
      {
        matterId: MATTER_A,
        priority: 200,
        agentCode: 'intake-agent',
        customerExternalId: null,
        signalPattern: null,
      },
    ];
    expect(resolveMatterAttribution(baseRecord, ctx({ rules }))).toEqual({
      matterId: MATTER_B,
      matterSource: 'rule',
    });
  });

  it('a priority TIE resolves to the earlier-created rule (array order), deterministically', () => {
    const rules = [
      {
        matterId: MATTER_A,
        priority: 100,
        agentCode: 'intake-agent',
        customerExternalId: null,
        signalPattern: null,
      },
      {
        matterId: MATTER_B,
        priority: 100,
        agentCode: 'intake-agent',
        customerExternalId: null,
        signalPattern: null,
      },
    ];
    expect(resolveMatterAttribution(baseRecord, ctx({ rules }))).toEqual({
      matterId: MATTER_A,
      matterSource: 'rule',
    });
  });

  it('a rule with NO matchers set matches nothing (fails closed)', () => {
    const rules = [
      {
        matterId: MATTER_B,
        priority: 1,
        agentCode: null,
        customerExternalId: null,
        signalPattern: null,
      },
    ];
    expect(resolveMatterAttribution(baseRecord, ctx({ rules }))).toEqual({
      matterId: null,
      matterSource: null,
    });
  });
});
