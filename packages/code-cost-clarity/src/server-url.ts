// Which MarginFront server this machine sends to, and the one door every
// request to it goes through. Read from the environment at call time, never at
// module load: the settings file is copied into the environment after this
// bundle has loaded, and a value captured earlier would miss it.

import {
  ALLOWED_TRANSPORT_TARGETS,
  INSECURE_HTTP_SETTING,
  SERVER_URL_SETTING,
  isInsecureHttpOptIn,
  isRequestToServer,
  resolveServerUrl,
  type ServerUrlResult,
} from "./transport-policy";

export const RETIRED_SERVER_URL_SETTING = "MARGINFRONT_INGEST_URL";

type Environment = Record<string, string | undefined>;

// `explicit` is an address a caller already holds (a flag, a typed answer).
// It replaces the environment's value but goes through the same checks.
export function resolveConfiguredServer(
  env: Environment = process.env,
  explicit?: string,
): ServerUrlResult {
  const configured = explicit ?? env[SERVER_URL_SETTING];
  const result = resolveServerUrl(configured, {
    allowInsecureHttp: isInsecureHttpOptIn(env[INSECURE_HTTP_SETTING]),
  });
  if (result.ok) return result;

  const nothingConfigured =
    typeof configured !== "string" || configured.trim() === "";
  if (nothingConfigured && env[RETIRED_SERVER_URL_SETTING]) {
    return {
      ok: false,
      problem: `${result.problem} ${RETIRED_SERVER_URL_SETTING} is set, but this program does not read it: replace it with ${SERVER_URL_SETTING}, which takes the address up to and including /v1.`,
    };
  }
  return result;
}

export function usageRecordUrl(serverUrl: string): string {
  return `${serverUrl}/sdk/usage/record`;
}

export function keyCheckUrl(serverUrl: string): string {
  return `${serverUrl}/verify`;
}

export function keyIdentityUrl(serverUrl: string): string {
  return `${serverUrl}/me/key`;
}

export function controlBaseUrl(serverUrl: string): string {
  return `${serverUrl}/control`;
}

// Throws instead of sending when the address is off the configured server, and
// instead of following when the server answers with a redirect: either way the
// x-api-key header never leaves the one server the operator named.
export async function sendToServer(
  serverUrl: string,
  url: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!isRequestToServer(url, serverUrl)) {
    throw new Error(
      `request not sent: its address is outside ${ALLOWED_TRANSPORT_TARGETS}, and the API key is only ever sent to that one server`,
    );
  }
  const response = await fetchImpl(url, { ...init, redirect: "manual" });
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new Error(
      `the server at ${serverUrl} answered with a redirect (HTTP ${response.status}), which is refused so the API key never follows one to another address. Set ${SERVER_URL_SETTING} to the server's final API address, including https:// and the /v1 path`,
    );
  }
  return response;
}
