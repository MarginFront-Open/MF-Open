/**
 * Track Usage Events Example
 *
 * Demonstrates how to record usage events for billing.
 * Every event needs `model` and `modelProvider` so MarginFront
 * knows what service was used and can calculate costs automatically.
 *
 * By default, fireAndForget is true — usage.record() never throws.
 * Network failures retry via the buffer. Validation errors log a
 * warning and drop. Your agent keeps running no matter what.
 *
 * Run with: npx ts-node examples/track-events.ts
 */

import { MarginFrontClient, ValidationError } from "../src";

async function main() {
  const client = new MarginFrontClient({
    apiKey: "mf_sk_your_secret_key",
    baseUrl: "http://localhost:4000/v1",
  });

  // -------------------------------------------------------
  // 1. Single LLM event (OpenAI, Anthropic, etc.)
  //    Pass inputTokens and outputTokens so MarginFront
  //    can calculate the cost per call automatically.
  // -------------------------------------------------------
  console.log("Recording an LLM usage event...");
  await client.usage.record({
    customerExternalId: "cust_123",
    agentCode: "sourcing-agent",
    signalName: "llm_call",
    model: "gpt-4o",
    modelProvider: "openai",
    inputTokens: 523,
    outputTokens: 117,
  });
  console.log("LLM event recorded (or buffered for retry if network is down).");

  // -------------------------------------------------------
  // 2. Single non-LLM event (Twilio, AWS, etc.)
  //    Use `quantity` instead of token counts.
  //    model + modelProvider are still required so MarginFront
  //    knows which service to attribute the cost to.
  // -------------------------------------------------------
  console.log("\nRecording a non-LLM usage event...");
  await client.usage.record({
    customerExternalId: "cust_123",
    agentCode: "notification-agent",
    signalName: "sms_sent",
    model: "twilio-sms",
    modelProvider: "twilio",
    quantity: 3,
  });
  console.log("Non-LLM event recorded.");

  // -------------------------------------------------------
  // 3. Batch with mixed event types
  //    Send multiple events at once. You can mix LLM and
  //    non-LLM events in the same batch.
  // -------------------------------------------------------
  console.log("\nRecording a batch of mixed events...");
  const batchResult = await client.usage.recordBatch([
    {
      customerExternalId: "cust_123",
      agentCode: "sourcing-agent",
      signalName: "llm_call",
      model: "claude-sonnet-4-20250514",
      modelProvider: "anthropic",
      inputTokens: 1024,
      outputTokens: 256,
    },
    {
      customerExternalId: "cust_456",
      agentCode: "notification-agent",
      signalName: "sms_sent",
      model: "twilio-sms",
      modelProvider: "twilio",
      quantity: 5,
    },
    {
      customerExternalId: "cust_789",
      agentCode: "sourcing-agent",
      signalName: "llm_call",
      model: "gpt-4o-mini",
      modelProvider: "openai",
      inputTokens: 200,
      outputTokens: 50,
      usageDate: new Date().toISOString(),
      metadata: {
        endpoint: "/chat/completions",
        purpose: "lead-scoring",
      },
    },
  ]);

  console.log("Batch results:");
  console.log(`  Processed: ${batchResult.processed}`);
  console.log(`  Successful: ${batchResult.successful}`);
  console.log(`  Failed: ${batchResult.failed}`);

  // Log successful records
  if (batchResult.results.success.length > 0) {
    console.log("\nSuccessful records:");
    batchResult.results.success.forEach((record) => {
      console.log(
        `  - ${record.customerExternalId}: ${record.signalName} (${record.model})`,
      );
    });
  }

  // Log failed records
  if (batchResult.results.failed.length > 0) {
    console.log("\nFailed records:");
    batchResult.results.failed.forEach((failure) => {
      console.log(`  - ${failure.record.customerExternalId}: ${failure.error}`);
    });
  }

  // -------------------------------------------------------
  // 4. What happens on validation error with fireAndForget
  //    Missing required fields (like model) won't throw —
  //    they log a warning and drop the event. Your agent
  //    keeps running.
  // -------------------------------------------------------
  console.log("\nSending an event with missing required field (model)...");
  await client.usage.record({
    customerExternalId: "cust_123",
    agentCode: "sourcing-agent",
    signalName: "llm_call",
    // model is missing — this will log a warning but NOT throw
    // modelProvider is missing too
  } as any); // "as any" just to show what happens; don't do this in real code
  console.log(
    "No crash! The SDK logged a validation warning and dropped the event.",
  );
  console.log(
    "Check your console output above — you should see a warning about the missing fields.",
  );
}

main();
