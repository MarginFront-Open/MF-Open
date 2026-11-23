/**
 * HTTP Client Wrapper
 * Handles all API requests with proper error handling, authentication, retry logic, and telemetry
 */

import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from "axios";
import { version as packageJsonVersion } from "../../package.json";
import { parseApiError, InitializationError, NetworkError } from "../errors";
import {
  ALLOWED_TRANSPORT_TARGETS,
  INSECURE_HTTP_SETTING,
  SERVER_URL_SETTING,
  isInsecureHttpOptIn,
  isRequestToServer,
  resolveServerUrl,
} from "../transport-policy";
import type {
  MarginFrontConfig,
  ApiErrorResponse,
  LogLevel,
  LogHandler,
  TelemetryHandler,
  RequestMetrics,
  TelemetryStats,
} from "../types";

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 300;

// Injected by tsup `define` at build time (see tsup.config.ts); undefined when
// running from source — the `typeof` guard below keeps that safe.
declare const __SDK_VERSION__: string;

export function resolveSdkVersion(
  packageVersion: unknown = packageJsonVersion,
): string {
  if (typeof __SDK_VERSION__ === "string" && __SDK_VERSION__.length > 0) {
    return __SDK_VERSION__;
  }
  if (typeof packageVersion === "string" && packageVersion.length > 0) {
    return packageVersion;
  }
  return "0.0.0-unknown";
}

const SDK_VERSION = resolveSdkVersion();

// Extend AxiosRequestConfig to include metadata
interface CustomRequestConfig extends AxiosRequestConfig {
  metadata?: {
    requestId?: string;
    telemetryTracked?: boolean;
    retryCount?: number;
  };
}

/**
 * Logger class for SDK logging
 */
class Logger {
  private readonly enabled: boolean;
  private readonly minLevel: LogLevel;
  private readonly handler: LogHandler;

  private readonly levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(config: MarginFrontConfig) {
    this.enabled = config.logging?.enabled ?? config.debug ?? false;
    this.minLevel = config.logging?.level ?? "info";
    this.handler = config.logging?.handler ?? this.defaultHandler;
  }

  private defaultHandler: LogHandler = (level, message, data) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [MarginFront] [${level.toUpperCase()}] ${message}`;
    const logFn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    if (data) {
      logFn(logMessage, data);
    } else {
      logFn(logMessage);
    }
  };

  private shouldLog(level: LogLevel): boolean {
    return (
      this.enabled &&
      this.levelPriority[level] >= this.levelPriority[this.minLevel]
    );
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog("debug")) this.handler("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog("info")) this.handler("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog("warn")) this.handler("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    if (this.shouldLog("error")) this.handler("error", message, data);
  }
}

/**
 * Telemetry class for tracking request metrics
 */
class Telemetry {
  private readonly enabled: boolean;
  private readonly sampleRate: number;
  private readonly handler: TelemetryHandler;
  private activeRequests: Map<string, RequestMetrics> = new Map();

  private requestCount = 0;
  private successCount = 0;
  private errorCount = 0;
  private totalDuration = 0;
  private errorTypes: Map<string, number> = new Map();

  constructor(config: MarginFrontConfig) {
    this.enabled = config.telemetry?.enabled ?? false;
    this.sampleRate = config.telemetry?.sampleRate ?? 1;
    this.handler = config.telemetry?.handler ?? (() => {});
  }

  private shouldCollect(): boolean {
    return this.enabled && Math.random() <= this.sampleRate;
  }

  generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  normalizePath(path: string): string {
    if (!path) return "";
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return normalizedPath
      .replace(
        /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "/:id",
      )
      .replace(/\/\d+(?=\/|$)/g, "/:id");
  }

  startRequest(
    method: string,
    path: string,
    requestId?: string,
  ): { requestId: string; isTracked: boolean } {
    const shouldTrack = this.shouldCollect();
    const id = requestId || this.generateRequestId();

    if (shouldTrack) {
      const metrics: RequestMetrics = {
        requestId: id,
        method: method.toUpperCase(),
        path: this.normalizePath(path),
        startTime: Date.now(),
      };
      this.activeRequests.set(id, metrics);
    }

    return { requestId: id, isTracked: shouldTrack };
  }

  endRequest(
    requestId: string,
    statusCode?: number,
    error?: Error,
    retryCount?: number,
  ): void {
    const metrics = this.activeRequests.get(requestId);
    if (!metrics) return;

    metrics.endTime = Date.now();
    metrics.duration = metrics.endTime - metrics.startTime;
    metrics.statusCode = statusCode;
    metrics.success = !error && (statusCode ? statusCode < 400 : true);
    metrics.retryCount = retryCount || 0;

    if (error) {
      metrics.errorMessage = error.message;
      metrics.errorType = error.name || "UnknownError";
      const currentCount = this.errorTypes.get(metrics.errorType) || 0;
      this.errorTypes.set(metrics.errorType, currentCount + 1);
      this.errorCount++;
    } else {
      this.successCount++;
    }

    this.requestCount++;
    this.totalDuration += metrics.duration;

    this.handler(metrics);
    this.activeRequests.delete(requestId);
  }

  getStats(): TelemetryStats {
    return {
      requestCount: this.requestCount,
      successCount: this.successCount,
      errorCount: this.errorCount,
      successRate:
        this.requestCount > 0 ? this.successCount / this.requestCount : 1,
      averageDuration:
        this.requestCount > 0 ? this.totalDuration / this.requestCount : 0,
      errorBreakdown: Object.fromEntries(this.errorTypes),
    };
  }

  resetStats(): void {
    this.requestCount = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.totalDuration = 0;
    this.errorTypes.clear();
  }
}

/**
 * Calculate exponential backoff time
 */
function calculateBackoff(retryCount: number, initialDelay: number): number {
  return initialDelay * Math.pow(2, retryCount);
}

/**
 * Sleep for a specified time
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a request should be retried
 */
function isRetryable(error: AxiosError): boolean {
  if (error.response) {
    const status = error.response.status;
    return status === 429 || (status >= 500 && status < 600);
  }
  return !error.response; // Network errors
}

function readEnvSetting(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[name];
}

const ABSOLUTE_URL_PATTERN = /^([a-z][a-z\d+\-.]*:)?\/\//i;

function resolveRequestUrl(baseUrl: string, path: string): string {
  if (ABSOLUTE_URL_PATTERN.test(path)) return path;
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

/**
 * HTTP client for making API requests to MarginFront
 */
export class HttpClient {
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly telemetry: Telemetry;
  private readonly retries: number;
  private readonly retryDelay: number;

  constructor(config: MarginFrontConfig) {
    this.logger = new Logger(config);
    this.telemetry = new Telemetry(config);
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.retryDelay = config.retryDelay ?? DEFAULT_RETRY_DELAY;

    const server = resolveServerUrl(
      config.baseUrl || config.baseURL || readEnvSetting(SERVER_URL_SETTING),
      {
        allowInsecureHttp:
          config.allowInsecureHttp ??
          isInsecureHttpOptIn(readEnvSetting(INSECURE_HTTP_SETTING)),
      },
    );
    if (!server.ok) {
      throw new InitializationError(
        `The MarginFront client could not be created. ${server.problem} In code, you can pass the same address as the baseUrl option (and allowInsecureHttp: true for the private-network case).`,
      );
    }
    const baseURL = server.baseUrl;
    this.baseUrl = baseURL;

    // Detect browser environment - User-Agent is a forbidden header in browsers
    // Use globalThis to safely check for browser globals
    const isBrowser =
      typeof globalThis !== "undefined" &&
      typeof (globalThis as Record<string, unknown>).window !== "undefined";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": config.apiKey,
      ...config.headers,
    };

    // Only set User-Agent in Node.js environment (forbidden in browsers).
    // The slug "marginfront-sdk" is what api-nest's detectSource() looks for
    // to attribute calls to the SDK surface — keep this exact prefix.
    if (!isBrowser) {
      headers["User-Agent"] = `marginfront-sdk/${SDK_VERSION}`;
    }

    this.client = axios.create({
      baseURL,
      timeout: config.timeout || DEFAULT_TIMEOUT,
      headers,
      // A redirect would carry the x-api-key header to wherever the server points.
      // maxRedirects covers Node's http adapter; fetchOptions covers the fetch
      // adapter that edge runtimes fall back to, which ignores maxRedirects.
      maxRedirects: 0,
      fetchOptions: { redirect: "manual" },
      // axios would otherwise read HTTP_PROXY / HTTPS_PROXY / ALL_PROXY and send the
      // whole request, key included, to that proxy as plain http with no TLS tunnel.
      proxy: false,
    });

    // Request interceptor
    this.client.interceptors.request.use(
      (requestConfig) => {
        const customConfig = requestConfig as CustomRequestConfig;
        customConfig.metadata = customConfig.metadata || {};

        // Generate request ID
        const { requestId, isTracked } = this.telemetry.startRequest(
          requestConfig.method || "GET",
          requestConfig.url || "",
          customConfig.metadata.requestId,
        );

        requestConfig.headers = requestConfig.headers || {};
        requestConfig.headers["X-Request-ID"] = requestId;
        customConfig.metadata.requestId = requestId;
        customConfig.metadata.telemetryTracked = isTracked;

        this.logger.debug(
          `Request: ${requestConfig.method?.toUpperCase()} ${requestConfig.url}`,
          {
            requestId,
          },
        );

        return requestConfig;
      },
      (error) => Promise.reject(error),
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        const customConfig = response.config as CustomRequestConfig;
        const requestId = customConfig.metadata?.requestId;
        const isTracked = customConfig.metadata?.telemetryTracked;

        if (isTracked && requestId) {
          this.telemetry.endRequest(requestId, response.status);
        }

        this.logger.debug(`Response: ${response.status}`, { requestId });
        return response;
      },
      (error) => {
        const customConfig = error.config as CustomRequestConfig;
        const requestId = customConfig?.metadata?.requestId;
        const isTracked = customConfig?.metadata?.telemetryTracked;
        const retryCount = customConfig?.metadata?.retryCount || 0;

        if (isTracked && requestId) {
          this.telemetry.endRequest(
            requestId,
            error.response?.status,
            error,
            retryCount,
          );
        }

        this.logger.error(`Error: ${error.message}`, {
          requestId,
          status: error.response?.status,
        });

        return Promise.reject(error);
      },
    );
  }

  /**
   * Make a request with retry logic
   */
  private async request<T>(config: CustomRequestConfig): Promise<T> {
    let lastError: AxiosError<ApiErrorResponse> | undefined;

    config.metadata = config.metadata || {};

    if (
      !isRequestToServer(
        resolveRequestUrl(this.baseUrl, config.url ?? ""),
        this.baseUrl,
      )
    ) {
      throw new InitializationError(
        `Request not sent. Its address is outside ${ALLOWED_TRANSPORT_TARGETS}, and the API key is only ever sent to that one server. Call the API with a path such as "/verify", not a full address.`,
      );
    }

    for (let retry = 0; retry <= this.retries; retry++) {
      try {
        config.metadata.retryCount = retry;

        if (retry > 0) {
          this.logger.info(`Retry attempt ${retry}/${this.retries}`, {
            requestId: config.metadata.requestId,
          });
        }

        const response = await this.client.request<T>(config);
        return response.data;
      } catch (error) {
        lastError = error as AxiosError<ApiErrorResponse>;

        const status = lastError.response?.status;
        if (status !== undefined && status >= 300 && status < 400) {
          throw new NetworkError(
            `Request stopped: the server at ${this.baseUrl} answered with a redirect (HTTP ${status}). Redirects are refused so the API key never follows one to another address. Set ${SERVER_URL_SETTING} (or baseUrl) to the server's final API address, including https:// and the /v1 path.`,
          );
        }

        if (retry < this.retries && isRetryable(lastError)) {
          const retryAfterHeader = lastError.response?.headers?.["retry-after"];
          const backoffTime = retryAfterHeader
            ? parseInt(retryAfterHeader, 10) * 1000
            : calculateBackoff(retry, this.retryDelay);

          this.logger.debug(`Retrying in ${backoffTime}ms...`);
          await sleep(backoffTime);
          continue;
        }

        break;
      }
    }

    throw parseApiError(lastError);
  }

  /**
   * Make a GET request
   */
  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const config: CustomRequestConfig = {
      method: "GET",
      url: path,
    };

    if (params) {
      config.params = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
      );
    }

    return this.request<T>(config);
  }

  /**
   * Make a POST request
   */
  async post<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>({
      method: "POST",
      url: path,
      data,
    });
  }

  /**
   * Make a PUT request
   */
  async put<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>({
      method: "PUT",
      url: path,
      data,
    });
  }

  /**
   * Make a PATCH request
   */
  async patch<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>({
      method: "PATCH",
      url: path,
      data,
    });
  }

  /**
   * Make a DELETE request
   */
  async delete<T = void>(path: string): Promise<T> {
    return this.request<T>({
      method: "DELETE",
      url: path,
    });
  }

  /**
   * Get telemetry statistics
   */
  getTelemetryStats(): TelemetryStats {
    return this.telemetry.getStats();
  }

  /**
   * Reset telemetry statistics
   */
  resetTelemetryStats(): void {
    this.telemetry.resetStats();
  }
}
