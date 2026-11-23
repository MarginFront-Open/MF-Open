import { readFileSync } from 'fs';
import { join } from 'path';

const ENV_FILE = '.env.marginfront.cli';

/**
 * Load defaults from .env.marginfront.cli in the current working directory.
 * This file is ONLY read when using the CLI — it has zero effect when the
 * SDK is imported as a library.
 */
export function loadCliEnv(): Record<string, string> {
  const filePath = join(process.cwd(), ENV_FILE);
  try {
    const contents = readFileSync(filePath, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      env[key] = value;
    }
    return env;
  } catch {
    // File doesn't exist — that's fine, all values must come from CLI args
    return {};
  }
}
