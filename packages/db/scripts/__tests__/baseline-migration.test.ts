import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PRISMA_DIR = path.join(__dirname, "..", "..", "prisma");
const MIGRATIONS = path.join(PRISMA_DIR, "migrations");
const sql = fs.readFileSync(
  path.join(MIGRATIONS, "0_init", "migration.sql"),
  "utf8",
);
const schema = fs.readFileSync(path.join(PRISMA_DIR, "schema.prisma"), "utf8");

function migrationFolders(): string[] {
  return fs
    .readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("the baseline migration", () => {
  it("is the first migration, so a new database is built by it alone", () => {
    expect(migrationFolders()[0]).toBe("0_init");
  });

  it("creates a table for every model in schema.prisma", () => {
    const models = Array.from(
      schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm),
    );
    expect(models.length).toBeGreaterThan(50);
    const missing = models
      .map(([, name, body]) => /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name)
      .filter((table) => !sql.includes(`CREATE TABLE "${table}" (`));
    expect(missing).toEqual([]);
  });

  it("creates every enum in schema.prisma", () => {
    const enums = Array.from(schema.matchAll(/^enum (\w+) \{/gm)).map(
      ([, name]) => name,
    );
    expect(enums.length).toBeGreaterThan(20);
    expect(
      enums.filter((name) => !sql.includes(`CREATE TYPE "${name}" AS ENUM`)),
    ).toEqual([]);
  });

  it("keeps the optional columns nullable and default-free", () => {
    expect(sql).toMatch(/^\s+"roiAssumptions" JSONB,$/m);
    expect(sql).toMatch(/^\s+"billingIdentity" JSONB,$/m);
    expect(sql).toMatch(/^\s+"baselineValue" DECIMAL\(18,6\),$/m);
    expect(sql).toMatch(/^\s+"baselineSource" VARCHAR\(10\),$/m);
  });

  it("carries the three things schema.prisma cannot express", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "uq_customer_alerts_functional_tuple"[^;]+NULLS NOT DISTINCT;/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "idx_signal_events_matter_attributed" ON "signal_events"\("matterId"\) WHERE "matterId" IS NOT NULL;/,
    );
    expect(sql).toMatch(/"alertThresholds" INTEGER\[\] NOT NULL DEFAULT/);
  });

  it("needs no extension: a managed database user can run it", () => {
    expect(sql).not.toMatch(/CREATE EXTENSION/i);
  });

  it("carries no tracker ids or environment nicknames", () => {
    expect(sql).not.toMatch(/\b[A-Z]{2,10}-\d{2,6}\b/);
    expect(sql).not.toMatch(/\b(funnel|ruling)\b/i);
  });
});
