import * as fs from "node:fs";
import * as path from "node:path";

// The Prisma CLI reads packages/db/.env by itself; a tsx script does not.
// Loading it here lets `migrate deploy` and the pricing scripts share one file.
export function loadPackageEnvFile(
  file: string = path.join(__dirname, "..", ".env"),
): void {
  if (process.env.DATABASE_URL) return;
  if (!fs.existsSync(file)) return;
  if (typeof process.loadEnvFile !== "function") {
    throw new Error(
      `Node ${process.versions.node} is too old to read packages/db/.env, so ` +
        `DATABASE_URL was not loaded from it. Fix: use Node 20.12 or newer, ` +
        `or export DATABASE_URL in this shell, then run the command again. ` +
        `Nothing was changed.`,
    );
  }
  process.loadEnvFile(file);
}

export function requireDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  throw new Error(
    "DATABASE_URL is not set, so there is no database to write to. Fix: " +
      "copy packages/db/.env.example to packages/db/.env and put your " +
      "PostgreSQL connection string in it, or export DATABASE_URL in this " +
      "shell, then run the command again. Nothing was changed.",
  );
}
