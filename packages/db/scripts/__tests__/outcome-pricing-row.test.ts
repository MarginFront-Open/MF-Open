/**
 * The one price-list row that makes a finished thing cost $0.
 *
 * A finished thing is a usage record priced by service_pricing like any other:
 * provider "outcome", model "work-item", rate 0. That provider word is the ONE
 * marker every read in the ROI tab uses, so two things have to stay true or the
 * feature silently breaks:
 *   1. the row is in BUILT_IN_ROWS, or the next pricing sync soft-retires it
 *      (isActive=false) and every finished thing after that lands UNPRICED;
 *   2. "item" is a known cost unit, or main() aborts the whole sync before any
 *      write, taking every OTHER price update down with it.
 * The baseline migration writes the row; this pins the script that keeps it.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { BUILT_IN_ROWS, KNOWN_COST_UNITS } from "../sync-service-pricing";
import { SWEEP_PROVIDER } from "../repair-unpriced-tool-children";

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");
const BASELINE_DIR = "0_init";

describe("the outcome/work-item price-list row", () => {
  const row = BUILT_IN_ROWS.find(
    (entry) => entry.externalId === "outcome/work-item",
  );

  it("is in the built-in list, so the next sync keeps it instead of retiring it", () => {
    expect(row).toBeDefined();
  });

  it("carries the exact shape the ROI read and the pricing path both depend on", () => {
    expect(row).toMatchObject({
      externalId: "outcome/work-item",
      displayName: "Finished work item",
      provider: "outcome",
      serviceType: "Finished work",
      inputCost: 0,
      outputCost: null,
      costUnit: "item",
      source: "builtin",
      isApi: true,
    });
  });

  it("prices at zero, not at no-price: a null rate would land NEEDS_COST_BACKFILL", () => {
    expect(row?.inputCost).toBe(0);
    expect(row?.inputCost).not.toBeNull();
  });

  it("uses a cost unit the sync will accept, or every price update aborts", () => {
    expect(KNOWN_COST_UNITS.has("item")).toBe(true);
  });

  it("is the only row under the outcome provider, which is what makes it a marker", () => {
    const outcomeRows = BUILT_IN_ROWS.filter(
      (entry) => entry.provider.toLowerCase() === "outcome",
    );
    expect(outcomeRows).toHaveLength(1);
  });

  it("sits outside the unpriced-tool sweep's blast radius", () => {
    // repair-unpriced-tool-children rewrites every child under ONE provider.
    // Putting finished work under "tool" would have handed a repair script the
    // power to re-price it; a separate word is what keeps them apart.
    expect(SWEEP_PROVIDER).toBe("tool");
    expect(SWEEP_PROVIDER).not.toBe(row?.provider);
  });
});

describe("the baseline migration that ships the row", () => {
  const file = path.join(MIGRATIONS, BASELINE_DIR, "migration.sql");
  const sql = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const insert = sql.slice(sql.indexOf('INSERT INTO "service_pricing"'));

  it("exists", () => {
    expect(fs.existsSync(file)).toBe(true);
    expect(insert).toContain('INSERT INTO "service_pricing"');
  });

  it("is idempotent, so a re-run cannot duplicate or retire it", () => {
    expect(insert).toContain('ON CONFLICT ("externalId") DO UPDATE');
    expect(insert).toContain('"isActive" = true');
    expect(insert).toContain('"inputCost" = 0');
  });

  it("writes the same canonicalName the pricing lookup matches on", () => {
    expect(insert).toContain("'outcome/work-item'");
    expect(insert).toContain("'work-item'");
    expect(insert).toContain("'outcome'");
  });

  it("writes the same source the sync writes, so the sync's retire step owns the row", () => {
    expect(insert).toContain("'builtin'");
  });
});
