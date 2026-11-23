#!/usr/bin/env node

/**
 * MarginFront SDK CLI (mf)
 *
 * FOR TESTING ONLY. This CLI reads from .env.marginfront.cli when present.
 * That file has zero effect on the SDK when used as a library.
 *
 * Usage (after `npm run build` in packages/sdk):
 *   node dist/cli/index.js verify --api-key mf_sk_... --base-url http://localhost:4000/v1
 *   node dist/cli/index.js track-event --api-key mf_sk_... --base-url http://localhost:4000/v1 --customer-id cust-1 --agent-code <code> --signal CALL_MINUTES --quantity 10
 */

import { Command } from "commander";
import { verifyCommand } from "./commands/verify";
import { trackEventCommand } from "./commands/track-event";
import { version as sdkPackageVersion } from "../../package.json";

const WARNING = `
\x1b[33m⚠️  CLI mode — for testing only.\x1b[0m
\x1b[33m   .env.marginfront.cli is NOT used when the SDK is imported as a library.\x1b[0m
`;

const program = new Command()
  .name("mf")
  .description("MarginFront SDK CLI (testing tool)")
  .version(sdkPackageVersion)
  .hook("preAction", () => {
    console.log(WARNING);
  });

program.addCommand(verifyCommand());
program.addCommand(trackEventCommand());

void program.parseAsync();
