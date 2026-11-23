import {
  INSECURE_HTTP_SETTING,
  SERVER_URL_SETTING,
  isInsecureHttpOptIn,
  resolveServerUrl,
  type ServerUrlResult,
} from "./transport-policy.js";

const RETIRED_SERVER_URL_SETTING = "MF_API_BASE_URL";

/**
 * Which MarginFront server this MCP server talks to, read from the environment.
 * There is no default: a missing or unsafe MARGINFRONT_API_URL is a problem the
 * caller must stop on.
 */
export function resolveStartupServer(
  env: Record<string, string | undefined>,
): ServerUrlResult {
  const configured = env[SERVER_URL_SETTING];
  const result = resolveServerUrl(configured, {
    allowInsecureHttp: isInsecureHttpOptIn(env[INSECURE_HTTP_SETTING]),
  });
  if (result.ok) return result;

  const hasConfigured =
    typeof configured === "string" && configured.trim() !== "";
  if (!hasConfigured && env[RETIRED_SERVER_URL_SETTING]) {
    return {
      ok: false,
      problem: `${result.problem} ${RETIRED_SERVER_URL_SETTING} is set, but this server reads ${SERVER_URL_SETTING} instead: rename it to ${SERVER_URL_SETTING}.`,
    };
  }
  return result;
}
