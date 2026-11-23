/**
 * Unit tests for client.invoices.send().
 *
 * Mocks the HTTP layer and proves:
 *   - send() POSTs to /sdk/invoices/{id}/send (not the canonical /v1/invoices/{id}/send),
 *     so SDK traffic lands in the SDK throttler bucket.
 *   - Empty invoiceId throws ValidationError before any HTTP call.
 *   - Optional body fields (recipientEmail, subject, message) are passed through verbatim.
 *   - Omitted options resolve to an empty body, not `undefined` (api-nest's DTO is OK with
 *     either, but a deterministic shape makes wire captures + test snapshots easier to read).
 */

import { describe, it, expect, vi } from "vitest";
import { InvoicesResource } from "../resources/invoices";
import { ValidationError } from "../errors";

describe("InvoicesResource.send", () => {
  it("POSTs to /sdk/invoices/{id}/send with the provided options", async () => {
    const post = vi.fn().mockResolvedValue({
      success: true,
      message: "Invoice email sent successfully",
      emailId: "msg_abc123",
      recipientEmail: "billing@customer.example",
    });
    const http = { post, get: vi.fn() } as any;
    const resource = new InvoicesResource(http);

    const result = await resource.send("inv_abc", {
      recipientEmail: "billing@customer.example",
      subject: "May invoice",
      message: "Card on file will be charged automatically.",
    });

    expect(post).toHaveBeenCalledWith("/sdk/invoices/inv_abc/send", {
      recipientEmail: "billing@customer.example",
      subject: "May invoice",
      message: "Card on file will be charged automatically.",
    });
    expect(result.success).toBe(true);
    expect(result.emailId).toBe("msg_abc123");
    expect(result.recipientEmail).toBe("billing@customer.example");
  });

  it("POSTs an empty object when no options are passed (not undefined)", async () => {
    const post = vi.fn().mockResolvedValue({
      success: true,
      message: "Invoice email sent successfully",
      emailId: "msg_xyz",
      recipientEmail: "customer@example.com",
    });
    const http = { post, get: vi.fn() } as any;
    const resource = new InvoicesResource(http);

    await resource.send("inv_xyz");

    expect(post).toHaveBeenCalledWith("/sdk/invoices/inv_xyz/send", {});
  });

  it("throws ValidationError when invoiceId is empty", async () => {
    const post = vi.fn();
    const http = { post, get: vi.fn() } as any;
    const resource = new InvoicesResource(http);

    await expect(resource.send("")).rejects.toBeInstanceOf(ValidationError);
    expect(post).not.toHaveBeenCalled();
  });

  it("propagates the API response shape unchanged (no client-side reshaping)", async () => {
    // If the API ever extends the response (e.g. adds tracking fields), the SDK should pass
    // them through. This test pins that contract — change here only if SendInvoiceResponse
    // actually drops fields.
    const apiResponse = {
      success: true,
      message: "Invoice email sent successfully",
      emailId: null, // null is a valid value per the type
      recipientEmail: "fallback@stored-on-customer.example",
    };
    const post = vi.fn().mockResolvedValue(apiResponse);
    const http = { post, get: vi.fn() } as any;
    const resource = new InvoicesResource(http);

    const result = await resource.send("inv_with_null_email_id");

    expect(result).toEqual(apiResponse);
  });
});
