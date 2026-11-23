/**
 * git-coordinates.ts — the ONE source of truth for turning the
 * git metadata the code-cost-clarity meter stamps onto internal coding events
 * (signal_events.metadata.repo / .branch / .commitSha) into cost-bucket keys.
 *
 * Pure and dependency-free (no Prisma, no Nest) so every surface that buckets
 * spend by repo or branch (the canonical CostMetrics Map path, api-nest's
 * /control/spend/breakdown) imports the exact same key rules instead of re-deriving them and drifting.
 *
 * Key rules:
 *   - A key exists only when the metadata value is a NON-EMPTY STRING. Absent
 *     keys, explicit JSON nulls (the cost meter passes partial tuples through verbatim),
 *     empty strings, and non-string values all yield null — the honest
 *     "no repo recorded" bucket. Nothing is ever stringified into a fake key.
 *   - Branch keys are composite "<repo>#<branch>" so 'main' in two repos stays
 *     two buckets. When the repo half is missing the key is "#<branch>" — the
 *     branch signal is kept rather than thrown away.
 *   - commitSha is deliberately NOT a bucket key: it is unique per commit, so
 *     grouping by it would produce one bucket per event (useless grain).
 */

function readStringField(metadata: unknown, field: string): string | null {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The repo bucket key ("owner/repo"), or null when no repo was recorded. */
export function gitRepoKey(metadata: unknown): string | null {
  return readStringField(metadata, "repo");
}

/**
 * The composite branch bucket key ("<repo>#<branch>"), or null when no branch
 * was recorded. An event with a branch but no repo keys as "#<branch>".
 */
export function gitBranchKey(metadata: unknown): string | null {
  const branch = readStringField(metadata, "branch");
  if (branch === null) return null;
  return `${gitRepoKey(metadata) ?? ""}#${branch}`;
}

/**
 * The recorded commit sha, or null when none was stamped. NOT a bucket key at
 * the repo/branch grain (see the header note), but the branch drill-down groups
 * by it to answer "which commits made this branch's spend", so the value read
 * follows the same non-empty-string rule as every other coordinate.
 */
export function gitCommitSha(metadata: unknown): string | null {
  return readStringField(metadata, "commitSha");
}
