/**
 * git-coordinates + getCostMetrics byRepo/byBranch. Runs under tsx in <1s
 * against an in-memory client stub (packages/db
 * src test convention — standalone assert scripts, NOT vitest):
 *
 *   npx tsx packages/db/src/lib/git-coordinates.test.ts
 *
 * WHY load-bearing: the coding meter stamps repo/branch/commitSha into
 * signal_events.metadata, and TWO server surfaces bucket cost by them — the
 * canonical CostMetrics Map path here and api-nest's /control/spend/breakdown.
 * Both import gitRepoKey/gitBranchKey so their buckets can never drift. The
 * things this must get right, each proven with a failure-capable assertion:
 *   1. Key semantics: absent key, explicit JSON null, empty string, and
 *      non-string values ALL bucket as null (the honest "no repo recorded"
 *      bucket) — they never vanish and never stringify into a fake key.
 *   2. Branch keys are composite "<repo>#<branch>" so 'main' in two repos
 *      stays two buckets. The NEGATIVE CONTROL replays the naive branch-only
 *      keying and shows it merges them — the exact collision the composite
 *      key exists to prevent.
 *   3. getCostMetrics rollup math: per-bucket cost sums and eventCounts,
 *      null-cost events counted but contributing 0, null buckets sorted last.
 */

import assert from "node:assert/strict";

import { gitBranchKey, gitRepoKey } from "./git-coordinates";
import { getCostMetrics } from "./revenue-metrics";

// ─── 1. Key semantics ───────────────────────────────────────────────────────

// Valid tuple.
assert.equal(
  gitRepoKey({ repo: "acme/platform", branch: "main" }),
  "acme/platform",
);
assert.equal(
  gitBranchKey({ repo: "acme/platform", branch: "main" }),
  "acme/platform#main",
);

// Partial tuple (repo=null passes through the cost meter verbatim): branch still keys,
// with an empty repo half, so the branch signal is not thrown away.
assert.equal(gitRepoKey({ repo: null, branch: "main" }), null);
assert.equal(gitBranchKey({ repo: null, branch: "main" }), "#main");

// Absent keys, explicit nulls, empty strings, non-strings → null bucket.
for (const metadata of [
  {},
  { repo: null, branch: null },
  { repo: "", branch: "" },
  { repo: 123, branch: 456 },
  { repo: ["a"], branch: { b: 1 } },
  null,
  undefined,
  "not-an-object",
  42,
  ["array"],
]) {
  assert.equal(
    gitRepoKey(metadata),
    null,
    `repo key for ${JSON.stringify(metadata)}`,
  );
  assert.equal(
    gitBranchKey(metadata),
    null,
    `branch key for ${JSON.stringify(metadata)}`,
  );
}

// Repo present but branch missing (detached HEAD): repo keys, branch does not.
assert.equal(gitRepoKey({ repo: "acme/platform" }), "acme/platform");
assert.equal(gitBranchKey({ repo: "acme/platform" }), null);

// ─── 2. Composite branch key vs the naive collision (negative control) ─────

const collisionEvents = [
  { repo: "acme/platform", branch: "main" },
  { repo: "acme/agents", branch: "main" },
];
const compositeKeys = new Set(collisionEvents.map((m) => gitBranchKey(m)));
assert.equal(
  compositeKeys.size,
  2,
  "composite keys keep same-named branches apart",
);

// NEGATIVE CONTROL: the naive branch-only key merges the two repos' 'main'
// into one bucket: the collision the composite key prevents.
const naiveKeys = new Set(
  collisionEvents.map((m) => (m as { branch?: string }).branch ?? null),
);
assert.equal(naiveKeys.size, 1, "negative control: naive keying WOULD collide");

// ─── 3. getCostMetrics byRepo / byBranch rollup ────────────────────────────

interface StubEvent {
  customerId: string;
  agentId: string;
  signalId: string | null;
  usageDate: Date;
  usageCost: number | null;
  environment: string | null;
  metadata: unknown;
  subscriptions: { planId: string } | null;
  signals: { costCategory: string } | null;
  raw_ingest_events: { payload: unknown } | null;
}

const baseEvent = (overrides: Partial<StubEvent>): StubEvent => ({
  customerId: "cust-1",
  agentId: "agent-1",
  signalId: "signal-1",
  usageDate: new Date("2026-07-10T12:00:00.000Z"),
  usageCost: 0.01,
  environment: null,
  metadata: {},
  subscriptions: null,
  signals: null,
  raw_ingest_events: null,
  ...overrides,
});

const events: StubEvent[] = [
  baseEvent({
    usageCost: 1.5,
    metadata: { repo: "acme/platform", branch: "main" },
  }),
  baseEvent({
    usageCost: 2.5,
    metadata: { repo: "acme/platform", branch: "feat/x" },
  }),
  baseEvent({
    usageCost: 4.0,
    metadata: { repo: "acme/agents", branch: "main" },
  }),
  // No git metadata at all → the null bucket, still counted.
  baseEvent({ usageCost: 0.25, metadata: {} }),
  // Explicit JSON nulls (the cost meter's partial-tuple passthrough) → the null bucket.
  baseEvent({
    usageCost: null,
    metadata: { repo: null, branch: null, commitSha: null },
  }),
];

const stubDb = {
  signal_events: {
    findMany: () => Promise.resolve(events),
  },
} as never;

const WINDOW = {
  start: new Date("2026-07-01T00:00:00.000Z"),
  end: new Date("2026-07-31T23:59:59.999Z"),
};

const run = async () => {
  const metrics = await getCostMetrics(stubDb, "org-1", WINDOW);

  // byRepo: two named buckets + one null bucket, null last.
  assert.equal(metrics.byRepo.length, 3);
  const platform = metrics.byRepo.find((r) => r.repo === "acme/platform");
  const agents = metrics.byRepo.find((r) => r.repo === "acme/agents");
  const noRepo = metrics.byRepo.find((r) => r.repo === null);
  assert.ok(platform && agents && noRepo, "all three repo buckets exist");
  assert.ok(Math.abs(platform!.cost - 4.0) < 1e-9);
  assert.equal(platform!.eventCount, 2);
  assert.ok(Math.abs(agents!.cost - 4.0) < 1e-9);
  assert.equal(agents!.eventCount, 1);
  // The metadata-less events land in the null bucket — they do NOT vanish.
  assert.equal(noRepo!.eventCount, 2);
  assert.ok(
    Math.abs(noRepo!.cost - 0.25) < 1e-9,
    "null-cost event contributes 0, not nothing",
  );
  assert.equal(
    metrics.byRepo[metrics.byRepo.length - 1].repo,
    null,
    "null bucket sorts last",
  );

  // byBranch: composite keys keep the two 'main' branches apart.
  const branchKeys = metrics.byBranch.map((r) => r.branch);
  assert.ok(branchKeys.includes("acme/platform#main"));
  assert.ok(branchKeys.includes("acme/platform#feat/x"));
  assert.ok(branchKeys.includes("acme/agents#main"));
  assert.ok(branchKeys.includes(null));
  assert.equal(metrics.byBranch.length, 4);
  const platMain = metrics.byBranch.find(
    (r) => r.branch === "acme/platform#main",
  );
  assert.ok(Math.abs(platMain!.cost - 1.5) < 1e-9);
  assert.equal(platMain!.eventCount, 1);
  assert.equal(
    metrics.byBranch[metrics.byBranch.length - 1].branch,
    null,
    "null bucket sorts last",
  );

  // Totals are untouched by the repo/branch grouping: same events, same cost.
  assert.equal(metrics.eventCount, 5);
  assert.equal(metrics.eventCountWithNullCost, 1);
  assert.ok(Math.abs(metrics.cost - 8.25) < 1e-9);
};

run()
  .then(() => {
    console.log("git-coordinates.test.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
