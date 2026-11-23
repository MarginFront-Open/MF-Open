import { Command } from "commander";
import { MarginFrontClient } from "../../client";
import { loadCliEnv } from "../utils/env";
import { isInsecureHttpOptIn, maskApiKey } from "../../transport-policy";

export function trackEventCommand(): Command {
  return new Command("track-event")
    .description("Send a usage event to the MarginFront API")
    .option("--api-key <key>", "API key (mf_sk_*)")
    .option(
      "--base-url <url>",
      "Your MarginFront server's API address, e.g. https://billing.example.com/v1 (or set MARGINFRONT_API_URL)",
    )
    .option("--customer-id <id>", "Customer external ID")
    .option("--agent-code <code>", "Agent code (external ID set in the UI)")
    .option("--signal <name>", "Signal name (e.g. CALL_MINUTES)")
    .option("--quantity <number>", "Quantity to record (default: 1)", "1")
    .option("--metadata <json>", "Optional metadata as a JSON string")
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
      const customerId = options.customerId ?? env["MF_CUSTOMER_ID"];
      const agentCode = options.agentCode ?? env["MF_AGENT_CODE"];
      const signal = options.signal ?? env["MF_SIGNAL"];
      const quantity = Number(options.quantity ?? env["MF_QUANTITY"] ?? "1");
      const debug = options.debug ?? env["MF_DEBUG"] === "true";

      const missing: string[] = [];
      if (!apiKey) missing.push("--api-key (or MF_API_SECRET_KEY)");
      if (!customerId) missing.push("--customer-id (or MF_CUSTOMER_ID)");
      if (!agentCode) missing.push("--agent-code (or MF_AGENT_CODE)");
      if (!signal) missing.push("--signal (or MF_SIGNAL)");

      if (missing.length > 0) {
        console.error(
          "Error: missing required options:\n  " + missing.join("\n  "),
        );
        process.exit(1);
      }

      if (debug) {
        console.log("[debug] base-url:", baseUrl ?? "(not set)");
        console.log("[debug] api-key:", maskApiKey(apiKey));
        console.log("[debug] payload:", {
          customerId,
          agentCode,
          signal,
          quantity,
        });
      }

      let metadata: Record<string, unknown> | undefined;
      if (options.metadata) {
        try {
          metadata = JSON.parse(options.metadata);
        } catch {
          console.error("Error: --metadata must be valid JSON");
          process.exit(1);
        }
      }

      try {
        const client = new MarginFrontClient({
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          allowInsecureHttp,
        });
        const result = await client.trackEvent({
          customerExternalId: customerId,
          agentCode,
          signalName: signal,
          quantity,
          ...(metadata ? { metadata } : {}),
        });
        // fireAndForget (the default) never throws, so a dead key or a down
        // network lands here with delivered: false. Exiting 0 with a success
        // banner would hide the loss.
        const delivered =
          "delivered" in result ? result.delivered : result.success;
        if (!delivered) {
          console.error(
            "\nEvent wasn't delivered. This one-shot command exits before any retry could run, so the event is gone. The warning above says why the send failed.",
          );
          console.error(JSON.stringify(result, null, 2));
          process.exit(1);
        }
        console.log("\nEvent tracked successfully\n");
        console.log(JSON.stringify(result, null, 2));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("\nFailed to track event:", message);
        process.exit(1);
      }
    });
}
