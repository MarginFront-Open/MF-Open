import { describe, it, expect } from "vitest";
import { validateServiceEntry, validateUsageRecord } from "../utils/validation";
import type {
  MultiServiceEvent,
  ServiceEntry,
  SingleServiceEvent,
  UsageRecord,
} from "../types";

// ---------------------------------------------------------------------------
// Single-service fixtures.
// ---------------------------------------------------------------------------

// Common fields shared across single-service tests; broken records start
// from this and override the field they want to fail on.
const validSingleService: SingleServiceEvent = {
  customerExternalId: "cust-123",
  agentCode: "agent-abc",
  signalName: "api_call",
  model: "gpt-4o",
  modelProvider: "openai",
};

// ---------------------------------------------------------------------------
// Multi-service fixtures.
// ---------------------------------------------------------------------------

const claudeService: ServiceEntry = {
  model: "claude-sonnet-4-6",
  modelProvider: "anthropic",
  inputTokens: 12500,
  outputTokens: 8200,
};

const googlePlacesService: ServiceEntry = {
  model: "google-maps-places",
  modelProvider: "google",
  quantity: 3,
};

const validMultiService: MultiServiceEvent = {
  customerExternalId: "sandbox-customer-001",
  agentCode: "sourcing-bot",
  signalName: "sourcing-report",
  services: [claudeService, googlePlacesService],
};

// ===========================================================================
// SINGLE-SERVICE PATH
// ===========================================================================

describe("validateUsageRecord - single-service", () => {
  it("accepts a valid record with all required fields", () => {
    expect(() => validateUsageRecord(validSingleService)).not.toThrow();
  });

  it("rejects missing customerExternalId", () => {
    const record = { ...validSingleService, customerExternalId: "" };
    expect(() => validateUsageRecord(record)).toThrow(
      "customerExternalId is required",
    );
  });

  it("rejects missing agentCode", () => {
    const record = { ...validSingleService, agentCode: "" };
    expect(() => validateUsageRecord(record)).toThrow("agentCode is required");
  });

  it("rejects missing model", () => {
    const record = { ...validSingleService, model: "" };
    expect(() => validateUsageRecord(record)).toThrow(
      // With model empty, we still have modelProvider, so we hit
      // single-service path and require model.
      "model is required",
    );
  });

  it("rejects missing modelProvider", () => {
    const record = { ...validSingleService, modelProvider: "" };
    expect(() => validateUsageRecord(record)).toThrow(
      "modelProvider is required",
    );
  });

  it("rejects negative inputTokens", () => {
    const record = { ...validSingleService, inputTokens: -1 };
    expect(() => validateUsageRecord(record)).toThrow(
      "inputTokens must be non-negative",
    );
  });

  it("rejects negative outputTokens", () => {
    const record = { ...validSingleService, outputTokens: -5 };
    expect(() => validateUsageRecord(record)).toThrow(
      "outputTokens must be non-negative",
    );
  });

  it("accepts valid optional fields", () => {
    const record = {
      ...validSingleService,
      inputTokens: 100,
      outputTokens: 50,
      quantity: 1,
      usageDate: "2026-04-12T00:00:00Z",
      metadata: { foo: "bar" },
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });
});

// ===========================================================================
// SINGLE- AND MULTI-SERVICE SHAPE CASES
// Validation accepts every shape that's structurally well-formed; cost-status
// concerns (NEEDS_COST_BACKFILL, MISSING_VOLUME_DATA) are server-side.
// ===========================================================================

describe("validateUsageRecord - shape cases", () => {
  // Case 1: Single-service, known + volume present.
  it("single-service with known model + tokens", () => {
    const record: SingleServiceEvent = {
      ...validSingleService,
      inputTokens: 100,
      outputTokens: 50,
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });

  // Case 2: Single-service, unknown model. Validation passes — the server
  // will land the event with NEEDS_COST_BACKFILL until the model is mapped.
  it("single-service with unknown model passes validation", () => {
    const record: SingleServiceEvent = {
      ...validSingleService,
      model: "some-unknown-model-not-in-catalog",
      modelProvider: "custom",
      inputTokens: 100,
      outputTokens: 50,
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });

  // Case 3: Single-service, missing volume. Validation passes — the server
  // will land the event with MISSING_VOLUME_DATA until tokens are filled.
  it("single-service with missing volume passes validation", () => {
    const record: SingleServiceEvent = {
      ...validSingleService,
      // No inputTokens, outputTokens, or quantity. Validator accepts;
      // backend flags MISSING_VOLUME_DATA after model lookup.
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });

  // Case 4: Multi-service, all entries known + volume present.
  it("multi-service with all known + volume passes", () => {
    expect(() => validateUsageRecord(validMultiService)).not.toThrow();
  });

  // Case 5: Multi-service, one entry has an unknown model. Validation passes.
  it("multi-service with one unknown model passes validation", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      services: [
        claudeService,
        {
          model: "some-unknown-model",
          modelProvider: "custom",
          quantity: 1,
        },
      ],
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });

  // Case 6: Multi-service, one entry missing volume. Validation passes.
  it("multi-service with one entry missing volume passes", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      services: [
        claudeService,
        {
          model: "google-maps-places",
          modelProvider: "google",
          // No quantity — backend flags MISSING_VOLUME_DATA on this child.
        },
      ],
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });

  // Case 7: Multi-service mixing one unknown model and one missing volume.
  it("multi-service with one unknown + one missing volume passes", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      services: [
        {
          model: "unknown-thing",
          modelProvider: "custom",
          // Missing volume too — but validator only cares about shape.
        },
        {
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          inputTokens: 100,
          outputTokens: 50,
        },
      ],
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });

  // Case 8: Multi-service with the same (model, provider) listed twice.
  // This is a legitimate "two Claude calls in one outcome" pattern, NOT
  // a duplicate to reject.
  it("multi-service with same model + provider listed twice passes", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      services: [
        { ...claudeService, inputTokens: 1000, outputTokens: 500 },
        { ...claudeService, inputTokens: 2000, outputTokens: 800 },
      ],
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });
});

// ===========================================================================
// Multi-service guards (shape errors, no model-catalog dependency)
// ===========================================================================

describe("validateUsageRecord - multi-service guards", () => {
  it("rejects record missing both single-service fields and services[]", () => {
    const record = {
      customerExternalId: "cust-123",
      agentCode: "agent-abc",
      signalName: "api_call",
      // No model, no modelProvider, no services — totally ambiguous.
    } as unknown as UsageRecord;
    expect(() => validateUsageRecord(record)).toThrow(
      /Provide either model \+ modelProvider .* or services\[\]/,
    );
  });

  it("rejects record providing both model+modelProvider AND services[]", () => {
    const record = {
      ...validSingleService,
      // Add services on top — ambiguous.
      services: [claudeService],
    } as unknown as UsageRecord;
    expect(() => validateUsageRecord(record)).toThrow(/Cannot mix shapes/);
  });

  it("rejects multi-service with empty services[]", () => {
    const record = {
      customerExternalId: "cust-123",
      agentCode: "agent-abc",
      signalName: "api_call",
      services: [],
    } as unknown as UsageRecord;
    expect(() => validateUsageRecord(record)).toThrow(/services\[\] is empty/);
  });

  it("rejects multi-service where services is not an array", () => {
    const record = {
      customerExternalId: "cust-123",
      agentCode: "agent-abc",
      signalName: "api_call",
      services: "not an array" as unknown as ServiceEntry[],
    } as unknown as UsageRecord;
    expect(() => validateUsageRecord(record)).toThrow(
      "services must be an array",
    );
  });

  it("rejects multi-service entry missing model", () => {
    const record = {
      ...validMultiService,
      services: [
        { modelProvider: "anthropic", inputTokens: 100 } as ServiceEntry,
      ],
    };
    expect(() => validateUsageRecord(record)).toThrow(
      "services[0].model is required",
    );
  });

  it("rejects multi-service entry missing modelProvider", () => {
    const record = {
      ...validMultiService,
      services: [
        { model: "claude-sonnet-4-6", inputTokens: 100 } as ServiceEntry,
      ],
    };
    expect(() => validateUsageRecord(record)).toThrow(
      "services[0].modelProvider is required",
    );
  });

  it("rejects multi-service entry with negative inputTokens", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      services: [{ ...claudeService, inputTokens: -1 }],
    };
    expect(() => validateUsageRecord(record)).toThrow(
      "services[0].inputTokens must be non-negative",
    );
  });

  it("rejects multi-service entry with negative outputTokens", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      services: [{ ...claudeService, outputTokens: -10 }],
    };
    expect(() => validateUsageRecord(record)).toThrow(
      "services[0].outputTokens must be non-negative",
    );
  });

  it("rejects multi-service entry with negative quantity (and points at the right index)", () => {
    // Two entries: [0] is fine, [1] has the bad quantity. Asserts the
    // validator's error message reports the actual offending index.
    const record: MultiServiceEvent = {
      ...validMultiService,
      services: [claudeService, { ...googlePlacesService, quantity: -3 }],
    };
    expect(() => validateUsageRecord(record)).toThrow(
      "services[1].quantity must be non-negative",
    );
  });

  it("points the error at the right index when service N is bad", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      services: [
        claudeService,
        googlePlacesService,
        // Third entry is bad: missing model.
        { modelProvider: "openai" } as ServiceEntry,
      ],
    };
    expect(() => validateUsageRecord(record)).toThrow(
      "services[2].model is required",
    );
  });
});

// ===========================================================================
// Common-field guards (apply to both shapes)
// ===========================================================================

describe("validateUsageRecord - common-field guards (both shapes)", () => {
  it("rejects missing signalName on multi-service shape too", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      signalName: "" as string,
    };
    expect(() => validateUsageRecord(record)).toThrow("signalName is required");
  });

  it("rejects missing customerExternalId on multi-service shape too", () => {
    const record: MultiServiceEvent = {
      ...validMultiService,
      customerExternalId: "",
    };
    expect(() => validateUsageRecord(record)).toThrow(
      "customerExternalId is required",
    );
  });

  it("rejects invalid usageDate string on either shape", () => {
    const record = {
      ...validSingleService,
      usageDate: "not-a-date",
    };
    expect(() => validateUsageRecord(record)).toThrow(
      "usageDate must be a valid ISO date string",
    );
  });

  it("accepts a Date object for usageDate", () => {
    const record = {
      ...validSingleService,
      usageDate: new Date("2026-04-26T00:00:00Z"),
    };
    expect(() => validateUsageRecord(record)).not.toThrow();
  });
});

// ===========================================================================
// validateServiceEntry helper (direct unit tests)
// ===========================================================================

describe("validateServiceEntry", () => {
  it("accepts a fully-specified LLM entry", () => {
    expect(() => validateServiceEntry(claudeService, "test")).not.toThrow();
  });

  it("accepts a fully-specified non-LLM entry", () => {
    expect(() =>
      validateServiceEntry(googlePlacesService, "test"),
    ).not.toThrow();
  });

  it("rejects entry that is not an object", () => {
    expect(() =>
      validateServiceEntry("string" as unknown as ServiceEntry, "test"),
    ).toThrow("test must be an object");
  });

  it("rejects null entry", () => {
    expect(() =>
      validateServiceEntry(null as unknown as ServiceEntry, "test"),
    ).toThrow("test must be an object");
  });

  it("uses the label in error messages", () => {
    expect(() =>
      validateServiceEntry(
        { modelProvider: "anthropic" } as ServiceEntry,
        "services[7]",
      ),
    ).toThrow("services[7].model is required");
  });
});
