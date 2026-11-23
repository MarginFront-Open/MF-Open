/**
 * Thin HTTP client for calling the MarginFront REST API.
 *
 * Why a standalone client instead of importing @marginfront/sdk?
 * The SDK is designed for fire-and-forget usage tracking inside user agents.
 * The MCP server needs the opposite: always wait for the response, always
 * return it to the LLM. Keeping this separate means zero coupling and the
 * MCP package can be built on its own.
 */

import { MCP_VERSION } from "./version.js";
import {
  ALLOWED_TRANSPORT_TARGETS,
  SERVER_URL_SETTING,
  isRequestToServer,
} from "./transport-policy.js";

// The shape of an error the MarginFront API returns. `code` + `required_roles` +
// `key_role` are populated on the insufficient_key_role 403 body
// (InsufficientKeyRoleException); absent on every other error.
interface ApiErrorBody {
  message?: string;
  error?: string;
  statusCode?: number;
  code?: string;
  required_roles?: string[];
  key_role?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    // Strip trailing slash so callers can use "/verify" without worrying
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Make a GET request. Query params are passed as a flat object —
   * undefined values are silently dropped.
   */
  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return this.request<T>(url.toString(), { method: "GET" });
  }

  /**
   * Make a POST request with a JSON body.
   */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.request<T>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * Make a PATCH request with a JSON body.
   */
  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.request<T>(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * Make a DELETE request.
   */
  async delete<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.request<T>(url, { method: "DELETE" });
  }

  /**
   * The actual fetch call. Handles auth header, error translation,
   * and JSON parsing.
   */
  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      // "marginfront-mcp" is what api-nest's detectSource() matches on to
      // attribute calls to the MCP surface. Version comes from version.ts,
      // which reads it from package.json at runtime.
      "User-Agent": `marginfront-mcp/${MCP_VERSION}`,
      ...(init.headers as Record<string, string> | undefined),
    };

    if (!isRequestToServer(url, this.baseUrl)) {
      throw new Error(
        `Request not sent. Its address is outside ${ALLOWED_TRANSPORT_TARGETS}, and the API key is only ever sent to that one server. This is a bug in the MCP server, not in your setup; please report it.`,
      );
    }

    // "manual" hands back the 3xx instead of following it, so the x-api-key
    // header can never travel to wherever a redirect points.
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
    });

    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new ApiError(
        response.status,
        `The MarginFront server at ${this.baseUrl} answered with a redirect (HTTP ${response.status}). Redirects are refused so the API key never follows one to another address. Set ${SERVER_URL_SETTING} to the server's final API address, including https:// and the /v1 path.`,
      );
    }

    if (!response.ok) {
      // Try to pull a human-readable message from the API response body
      let errorMessage = `HTTP ${response.status} ${response.statusText}`;
      let code: string | undefined;
      let requiredRoles: string[] | undefined;
      let keyRole: string | undefined;
      try {
        const errorBody = (await response.json()) as ApiErrorBody;
        if (errorBody.message) {
          errorMessage = errorBody.message;
        } else if (errorBody.error) {
          errorMessage = errorBody.error;
        }
        code = errorBody.code;
        requiredRoles = errorBody.required_roles;
        keyRole = errorBody.key_role;
      } catch {
        // Body wasn't JSON — use the status text we already have
      }

      throw new ApiError(
        response.status,
        errorMessage,
        code,
        requiredRoles,
        keyRole,
      );
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

/**
 * Error class for MarginFront API errors.
 * Carries the HTTP status so tool handlers can decide how to report it.
 * `code`/`requiredRoles`/`keyRole` are only set on an `insufficient_key_role`
 * 403; every other error leaves them undefined.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly requiredRoles?: string[],
    public readonly keyRole?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
