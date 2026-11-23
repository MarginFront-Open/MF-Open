/**
 * Spend Controls Resource
 *
 * Read AND manage internal code-spend caps from code: the same policies,
 * spend-vs-cap, and coverage the dashboard shows.
 *
 * Roles, as the server enforces them. `list`, `spend`, and `coverage` work with every key
 * role, including an ingest-only key, because the on-device brake reads them with
 * the same key it sends usage with. `breakdown` needs owner, admin, or finance.
 * Writes (`create` / `update` / `delete`) are owner or finance only and hit the
 * SAME api-nest endpoints the dashboard uses: one enforcement path, no side door.
 * A key without the role gets the server's own plain-English 403 surfaced verbatim
 * (parseApiError keeps the message intact), the same "Only an owner or finance
 * user can change spend caps" a dashboard user sees.
 */

import type { HttpClient } from "../utils/http";
import { validateRequired } from "../utils/validation";
import type {
  CreateSpendCapParams,
  DeleteSpendCapResponse,
  SpendBreakdownDimension,
  SpendBreakdownResponse,
  SpendCap,
  SpendCapPeriod,
  SpendCoverage,
  SpendReadback,
  UpdateSpendCapParams,
} from "../types";

/**
 * Resource for reading and managing spend caps.
 */
export class SpendControlsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List every cap policy for the organization. Each cap carries its plain
   * sentence, e.g. "Stop Claude spend at $200 for alice@acme.example per week".
   *
   * @example
   * ```typescript
   * const caps = await client.spendControls.list();
   * caps.forEach((c) => console.log(c.sentence));
   * ```
   */
  async list(): Promise<SpendCap[]> {
    return this.http.get<SpendCap[]>("/control/caps");
  }

  /**
   * Spend-so-far for the current period window (computed in UTC server-side).
   * Returns the org total; pass a teammate's `customerExternalId` to also get
   * that teammate's number. `spentUsd` is null when there is no priced usage —
   * honest absence, never a coerced 0.
   *
   * @example
   * ```typescript
   * const week = await client.spendControls.spend("week");
   * console.log(week.org.spentUsd); // e.g. 42.5 or null
   *
   * const dev = await client.spendControls.spend("week", "alice@acme.example");
   * console.log(dev.dev?.spentUsd);
   * ```
   */
  async spend(
    period: SpendCapPeriod,
    customerExternalId?: string,
  ): Promise<SpendReadback> {
    validateRequired(period, "period");
    return this.http.get<SpendReadback>("/control/spend", {
      period,
      customerExternalId,
    });
  }

  /**
   * Internal coding-agent spend for the current period, grouped by git repo or
   * branch. Branch spend is the closest stand-in for cost per pull request;
   * events outside a tracked repo appear in the no-repo bucket (`noMetadata`).
   * `spentUsd` is null wherever there is no priced usage (honest absence,
   * never a coerced 0), and `coveragePercent` says how much of the activity
   * carries the repo/branch key.
   *
   * @example
   * ```typescript
   * const byBranch = await client.spendControls.breakdown("week", "branch");
   * byBranch.rows.forEach((r) => console.log(r.key, r.spentUsd));
   * console.log("untracked:", byBranch.noMetadata.spentUsd);
   * ```
   */
  async breakdown(
    period: SpendCapPeriod,
    dimension: SpendBreakdownDimension,
  ): Promise<SpendBreakdownResponse> {
    validateRequired(period, "period");
    validateRequired(dimension, "dimension");
    return this.http.get<SpendBreakdownResponse>("/control/spend/breakdown", {
      period,
      dimension,
    });
  }

  /**
   * Cap-check coverage over the trailing 7 days, PER TOOL. Read `claudeCode` and
   * `codex`; the top-level `armed` / `total` count both tools together.
   *
   * Each tool reports `armed` / `notArmed` / `unknown` / `total` as distinct
   * teammates who used THAT tool. A teammate counts as armed only when every
   * machine we saw them use for it had the cap check running. `unknown` means we
   * could not tell, and it's never counted as armed. The two tools count
   * separately, so a teammate who uses both appears in both and the per-tool
   * totals don't sum to `total`. `asOf` is null when there's no recent activity.
   *
   * @example
   * ```typescript
   * const { claudeCode, codex } = await client.spendControls.coverage();
   * if (codex) {
   *   console.log(
   *     `Codex: ${codex.armed} of ${codex.total} have the cap check running, ` +
   *       `${codex.unknown} we can't tell about`,
   *   );
   * }
   * ```
   */
  async coverage(): Promise<SpendCoverage> {
    return this.http.get<SpendCoverage>("/control/coverage");
  }

  /**
   * Create a cap. Owner/finance only (server-enforced). A team or dev cap can
   * never exceed the org ceiling for the same provider — the server rejects it
   * with a plain message you can show as-is. The response echoes the new cap's
   * sentence.
   *
   * @example
   * ```typescript
   * const cap = await client.spendControls.create({
   *   scope: "dev",
   *   scopeValue: "alice@acme.example",
   *   amountUsd: 200,
   *   period: "week",
   *   mode: "enforce",
   * });
   * console.log(cap.sentence);
   * ```
   */
  async create(params: CreateSpendCapParams): Promise<SpendCap> {
    return this.http.post<SpendCap>("/control/caps", {
      providerScope: "all",
      ...params,
    });
  }

  /**
   * Adjust an existing cap's amount / period / mode / cool-off / alert ladder.
   * Owner/finance only. The response echoes the updated cap's sentence.
   *
   * @example
   * ```typescript
   * const cap = await client.spendControls.update(capId, { amountUsd: 350 });
   * console.log(cap.sentence);
   * ```
   */
  async update(id: string, patch: UpdateSpendCapParams): Promise<SpendCap> {
    validateRequired(id, "id");
    return this.http.patch<SpendCap>(
      `/control/caps/${encodeURIComponent(id)}`,
      patch,
    );
  }

  /**
   * Delete a cap. Owner/finance only. The response echoes the removed cap's
   * sentence so you can confirm what was deleted.
   *
   * @example
   * ```typescript
   * const { sentence } = await client.spendControls.delete(capId);
   * console.log(`Removed: ${sentence}`);
   * ```
   */
  async delete(id: string): Promise<DeleteSpendCapResponse> {
    validateRequired(id, "id");
    return this.http.delete<DeleteSpendCapResponse>(
      `/control/caps/${encodeURIComponent(id)}`,
    );
  }
}
