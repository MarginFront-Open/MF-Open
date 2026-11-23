import { Command } from "commander";
import { MarginFrontClient } from "../../client";
import { loadCliEnv } from "../utils/env";
import { isInsecureHttpOptIn, maskApiKey } from "../../transport-policy";

export function verifyCommand(): Command {
  return new Command("verify")
    .description("Verify an API key and display organization details")
    .option("--api-key <key>", "API key (mf_sk_* or mf_pk_*)")
    .option(
      "--base-url <url>",
      "Your MarginFront server's API address, e.g. https://billing.example.com/v1 (or set MARGINFRONT_API_URL)",
    )
    .option("--debug", "Enable debug output")
    .action(async (options) => {
      const env = loadCliEnv();

      const apiKey = options.apiKey ?? env["MF_API_SECRET_KEY"];
      const baseUrl =
        options.baseUrl ??
        process.env["MARGINFRONT_API_URL"] ??
        env["MARGINFRONT_API_URL"];
      const allowInsecureHttp = isInsecureHttpOptIn(
        process.env["MARGINFRONT_ALLOW_INSECURE_HTTP"] ??
          env["MARGINFRONT_ALLOW_INSECURE_HTTP"],
      );
      const debug = options.debug ?? env["MF_DEBUG"] === "true";

      if (!apiKey) {
        console.error(
          "Error: --api-key is required (or set MF_API_SECRET_KEY in .env.marginfront.cli)",
        );
        process.exit(1);
      }

      if (debug) {
        console.log("[debug] base-url:", baseUrl ?? "(not set)");
        console.log("[debug] api-key:", maskApiKey(apiKey));
      }

      try {
        const client = new MarginFrontClient({
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          allowInsecureHttp,
        });
        const result = await client.verify();
        console.log("\nVerified successfully\n");
        console.log(JSON.stringify(result, null, 2));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("\nVerification failed:", message);
        process.exit(1);
      }
    });
}
