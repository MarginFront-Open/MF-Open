// The one outbound-transport policy shared by @marginfront/code-cost-clarity,
// @marginfront/sdk and @marginfront/mcp. The packages are built separately and
// cannot import each other, so this file is copied byte-for-byte into each one.
// A test in every package pins the three copies identical; edit all three together.

export const SERVER_URL_SETTING = "MARGINFRONT_API_URL";
export const INSECURE_HTTP_SETTING = "MARGINFRONT_ALLOW_INSECURE_HTTP";

export const ALLOWED_TRANSPORT_TARGETS =
  "the server set in MARGINFRONT_API_URL (https, or http on this machine)";

const SERVER_URL_EXAMPLE =
  "https://billing.example.com/v1 (or http://localhost:4000/v1 for a server on this machine)";

export type ServerUrlResult =
  | { ok: true; baseUrl: string }
  | { ok: false; problem: string };

export interface ServerUrlOptions {
  allowInsecureHttp?: boolean;
}

export function isInsecureHttpOptIn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

// A literal-hostname match with no DNS lookup, so localhost.evil.com fails.
// URL parsing wraps an IPv6 literal in brackets, so ::1 arrives as "[::1]".
function isThisMachine(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

// There is deliberately no default server anywhere: a missing or bad value is
// a problem to report, never a reason to fall back to a built-in address.
// Problem text never echoes the raw value, which could carry a password.
export function resolveServerUrl(
  raw: string | undefined | null,
  options: ServerUrlOptions = {},
): ServerUrlResult {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    return {
      ok: false,
      problem: `No MarginFront server is set, so nothing can be sent. This software has no built-in server address. Set ${SERVER_URL_SETTING} to your own server's API address, for example ${SERVER_URL_EXAMPLE}.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      problem: `${SERVER_URL_SETTING} is not a valid web address, so nothing can be sent. Set it to your own server's full API address, for example ${SERVER_URL_EXAMPLE}.`,
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      problem: `${SERVER_URL_SETTING} does not start with https:// or http://, so nothing can be sent. Set it to your own server's full API address, for example ${SERVER_URL_EXAMPLE}.`,
    };
  }

  const shownAs = `${parsed.protocol}//${parsed.host}`;

  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      problem: `${SERVER_URL_SETTING} has a username or password inside the address, which would leak into logs. Remove the part before the @ sign; the API key is sent separately.`,
    };
  }

  if (parsed.search !== "" || parsed.hash !== "") {
    return {
      ok: false,
      problem: `${SERVER_URL_SETTING} (${shownAs}) has a "?" or "#" part, which a server address cannot carry. Remove everything from the "?" or "#" onward.`,
    };
  }

  if (
    parsed.protocol === "http:" &&
    !isThisMachine(parsed.hostname) &&
    options.allowInsecureHttp !== true
  ) {
    return {
      ok: false,
      problem: `${SERVER_URL_SETTING} points at ${shownAs}, which is unencrypted http on another machine, so your API key would travel in the clear. Use https:// instead. If this server is on a private network you trust, set ${INSECURE_HTTP_SETTING}=1 to allow it.`,
    };
  }

  return {
    ok: true,
    baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`,
  };
}

// True only when `requestUrl` is on the configured server: same scheme, host
// and port, and under the configured path. Checked right before every send.
export function isRequestToServer(
  requestUrl: string,
  serverBaseUrl: string,
): boolean {
  let request: URL;
  let server: URL;
  try {
    request = new URL(requestUrl);
    server = new URL(serverBaseUrl);
  } catch {
    return false;
  }
  if (request.origin !== server.origin) return false;
  if (request.username !== "" || request.password !== "") return false;
  const serverPath = server.pathname.replace(/\/+$/, "");
  return (
    request.pathname === serverPath ||
    request.pathname.startsWith(`${serverPath}/`)
  );
}

// Mask an API key for logs: prefix + "..." + last 4, or prefix-only for a short key.
// The one representation any package may print for a key. No path prints a raw key.
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 20) {
    return apiKey.substring(0, 8) + "...";
  }
  return apiKey.substring(0, 16) + "..." + apiKey.slice(-4);
}
