/**
 * MarginFront SDK Error Classes
 * Custom error types for different API error scenarios
 */

/**
 * Base error class for all MarginFront SDK errors
 */
export class MarginFrontError extends Error {
  /** HTTP status code from the API response */
  public readonly statusCode: number;
  /** Error code for programmatic handling */
  public readonly code: string;
  /** Additional error details from the API */
  public readonly details?: Record<string, unknown>;
  /** Additional error metadata */
  public readonly metadata: Record<string, unknown>;
  /** Request ID associated with the error */
  public readonly requestId?: string;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = "MARGINFRONT_ERROR",
    details?: Record<string, unknown>,
    metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MarginFrontError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.metadata = metadata;
    this.requestId = metadata.requestId as string | undefined;

    Object.setPrototypeOf(this, MarginFrontError.prototype);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when API authentication fails (401)
 * Usually indicates an invalid or expired API key
 */
export class AuthenticationError extends MarginFrontError {
  constructor(
    message: string = "Invalid or missing API key",
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 401, "AUTHENTICATION_ERROR", undefined, metadata);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Thrown when the API key doesn't have permission for the requested action (403)
 */
export class AuthorizationError extends MarginFrontError {
  /**
   * The roles the endpoint requires. Three states, and BRANCHING ON
   * TRUTHINESS GETS THE MIDDLE ONE WRONG: `[]` is truthy in JavaScript, so
   * `if (err.requiredRoles)` renders an empty role list. Branch on `.length`.
   *
   * - Non-empty array: the roles that would work. Safe to show the caller.
   * - `[]`: the server returned an `insufficient_key_role` body and DECLINED to
   *   name roles. Show `message` and render no role list. The global
   *   ingest-scope denial sends this deliberately: every role above the ingest
   *   floor clears that guard, but the route's own gate is usually narrower, so a
   *   role list here would send someone to mint a key that 403s again.
   * - `undefined`: not an `insufficient_key_role` body at all (e.g. the
   *   publishable-key write guard), which carries no role info.
   */
  public readonly requiredRoles?: string[];
  /** The role this API key actually carries. Set alongside requiredRoles. */
  public readonly keyRole?: string;

  constructor(
    message: string = "You do not have permission to perform this action",
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 403, "AUTHORIZATION_ERROR", undefined, metadata);
    this.name = "AuthorizationError";
    this.requiredRoles = metadata.requiredRoles as string[] | undefined;
    this.keyRole = metadata.keyRole as string | undefined;
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

/**
 * Thrown when a requested resource is not found (404)
 */
export class NotFoundError extends MarginFrontError {
  /** The type of resource that was not found */
  public readonly resourceType?: string;
  /** The ID of the resource that was not found */
  public readonly resourceId?: string;

  constructor(
    message: string = "Resource not found",
    resourceType?: string,
    resourceId?: string,
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 404, "NOT_FOUND_ERROR", undefined, metadata);
    this.name = "NotFoundError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Thrown when request validation fails (400/422)
 * Contains details about which fields failed validation
 */
export class ValidationError extends MarginFrontError {
  /** Object containing field-level validation errors */
  public readonly validationErrors?: Record<string, string[]>;

  constructor(
    message: string = "Validation failed",
    validationErrors?: Record<string, string[]>,
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 400, "VALIDATION_ERROR", validationErrors, metadata);
    this.name = "ValidationError";
    this.validationErrors = validationErrors;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Thrown when the API rate limit is exceeded (429)
 */
export class RateLimitError extends MarginFrontError {
  /** Number of seconds to wait before retrying */
  public readonly retryAfter?: number;

  constructor(
    message: string = "Rate limit exceeded",
    retryAfter?: number,
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 429, "RATE_LIMIT_ERROR", undefined, metadata);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * Thrown when there's a conflict with the current state (409)
 */
export class ConflictError extends MarginFrontError {
  constructor(
    message: string = "Resource conflict",
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 409, "CONFLICT_ERROR", undefined, metadata);
    this.name = "ConflictError";
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/**
 * Thrown when a network error occurs (no response from server)
 */
export class NetworkError extends MarginFrontError {
  /** The original error that caused the network failure */
  public readonly originalError?: Error;

  constructor(
    message: string = "Network error occurred",
    originalError?: Error,
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 0, "NETWORK_ERROR", undefined, metadata);
    this.name = "NetworkError";
    this.originalError = originalError;
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * Thrown when a request times out
 */
export class TimeoutError extends MarginFrontError {
  /** The timeout value in milliseconds that was exceeded */
  public readonly timeoutMs?: number;

  constructor(
    message: string = "Request timed out",
    timeoutMs?: number,
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 0, "TIMEOUT_ERROR", undefined, metadata);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Thrown when an internal server error occurs (500)
 */
export class InternalError extends MarginFrontError {
  constructor(
    message: string = "Internal server error",
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 500, "INTERNAL_ERROR", undefined, metadata);
    this.name = "InternalError";
    Object.setPrototypeOf(this, InternalError.prototype);
  }
}

/**
 * Thrown when SDK initialization fails
 */
export class InitializationError extends MarginFrontError {
  constructor(
    message: string = "Failed to initialize the SDK",
    metadata: Record<string, unknown> = {},
  ) {
    super(message, 0, "INITIALIZATION_ERROR", undefined, metadata);
    this.name = "InitializationError";
    Object.setPrototypeOf(this, InitializationError.prototype);
  }
}

/**
 * Generic API error
 */
export class ApiError extends MarginFrontError {
  /** API error code if available */
  public readonly errorCode?: string;

  constructor(
    message: string = "API request failed",
    statusCode?: number,
    errorCode?: string,
    metadata: Record<string, unknown> = {},
  ) {
    super(
      message,
      statusCode || 500,
      errorCode || "API_ERROR",
      undefined,
      metadata,
    );
    this.name = "ApiError";
    this.errorCode = errorCode;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// ============================================================================
// Error Factory
// ============================================================================

/**
 * Maps HTTP status codes to appropriate error classes
 */
export function createErrorFromResponse(
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): MarginFrontError {
  switch (statusCode) {
    case 400:
      return new ValidationError(
        message,
        details as Record<string, string[]>,
        metadata,
      );
    case 401:
      return new AuthenticationError(message, metadata);
    case 403:
      return new AuthorizationError(message, metadata);
    case 404:
      return new NotFoundError(message, undefined, undefined, metadata);
    case 409:
      return new ConflictError(message, metadata);
    case 422:
      return new ValidationError(
        message,
        details as Record<string, string[]>,
        metadata,
      );
    case 429:
      const retryAfter = metadata.retryAfter as number | undefined;
      return new RateLimitError(message, retryAfter, metadata);
    case 500:
    case 502:
    case 503:
    case 504:
      return new InternalError(message, metadata);
    default:
      return new ApiError(message, statusCode, "API_ERROR", metadata);
  }
}

/**
 * Parse API error response into appropriate error object
 */
export function parseApiError(error: unknown): MarginFrontError {
  const err = error as {
    message?: string;
    response?: {
      status?: number;
      data?: {
        message?: string;
        error?: string;
        code?: string;
        errors?: Record<string, string[]>;
      };
      headers?: { "retry-after"?: string };
    };
    config?: {
      url?: string;
      method?: string;
      headers?: { "X-Request-ID"?: string };
    };
    code?: string;
  };

  const message = err.message || "Unknown error";
  const statusCode = err.response?.status;
  const rawData = err.response?.data;
  const responseData: Record<string, unknown> =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : {};
  const requestId = err.config?.headers?.["X-Request-ID"] || "unknown";

  const safeString = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  // An insufficient_key_role 403 (InsufficientKeyRoleException) carries
  // required_roles + key_role in the response body — lift them onto AuthorizationError
  // so a caller can branch on WHICH roles would work instead of parsing the message.
  const requiredRolesRaw = responseData["required_roles"];
  const requiredRoles = Array.isArray(requiredRolesRaw)
    ? (requiredRolesRaw as unknown[]).filter(
        (r): r is string => typeof r === "string",
      )
    : undefined;

  const metadata = {
    requestId,
    url: err.config?.url,
    method: err.config?.method,
    responseData,
    retryAfter: err.response?.headers?.["retry-after"]
      ? parseInt(err.response.headers["retry-after"], 10)
      : undefined,
    requiredRoles,
    keyRole: safeString(responseData["key_role"]),
  };

  if (!statusCode) {
    if (err.code === "ECONNABORTED") {
      return new TimeoutError(message, undefined, metadata);
    }
    return new NetworkError(message, err as Error, metadata);
  }

  return createErrorFromResponse(
    statusCode,
    safeString(responseData["message"]) ??
      safeString(responseData["error"]) ??
      message,
    responseData["errors"] as Record<string, string[]> | undefined,
    metadata,
  );
}

/**
 * True when the error is a 401/403 from the API: the key is dead, not the
 * request, so no amount of retrying will deliver the event.
 */
// Duck-typed on statusCode instead of instanceof: the SDK ships dual CJS/ESM
// and a customer can end up with two copies of the error classes in one
// process, where instanceof silently returns false.
export function isAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { statusCode?: unknown }).statusCode;
  return status === 401 || status === 403;
}
