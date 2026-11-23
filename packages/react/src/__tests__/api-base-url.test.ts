import { describe, expect, it } from "vitest";
import { requireApiBaseUrl } from "../api-base-url";

describe("requireApiBaseUrl", () => {
  it("refuses a missing address and says how to fix it", () => {
    expect(() => requireApiBaseUrl(undefined)).toThrow(/needs an apiBaseUrl/);
    expect(() => requireApiBaseUrl(undefined)).toThrow(
      /http:\/\/localhost:4000\/v1/,
    );
  });

  it("refuses a blank address", () => {
    expect(() => requireApiBaseUrl("   ")).toThrow(/needs an apiBaseUrl/);
  });

  it("refuses something that is not an http or https URL", () => {
    expect(() => requireApiBaseUrl("api.example.com/v1")).toThrow(
      /not a web address/,
    );
    expect(() => requireApiBaseUrl("ftp://api.example.com/v1")).toThrow(
      /not a web address/,
    );
  });

  it("keeps the caller's address and drops trailing slashes", () => {
    expect(requireApiBaseUrl("https://billing.example.com/v1/")).toBe(
      "https://billing.example.com/v1",
    );
    expect(requireApiBaseUrl(" http://localhost:4000/v1 ")).toBe(
      "http://localhost:4000/v1",
    );
  });
});
