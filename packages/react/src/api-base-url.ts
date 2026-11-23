function isWebAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * MarginFrontProvider has no built-in server address: every app names its own
 * MarginFront API, so data can only ever go where the caller sends it.
 */
export function requireApiBaseUrl(apiBaseUrl: string | undefined): string {
  const trimmed = apiBaseUrl?.trim() ?? "";

  if (!trimmed) {
    throw new Error(
      "MarginFrontProvider needs an apiBaseUrl, and none was given. " +
        "The package has no built-in server address, so it cannot guess where your MarginFront API runs. " +
        'Pass the address of your own API, including /v1, for example <MarginFrontProvider apiBaseUrl="http://localhost:4000/v1">.',
    );
  }

  if (!isWebAddress(trimmed)) {
    throw new Error(
      `MarginFrontProvider got apiBaseUrl "${trimmed}", which is not a web address. ` +
        "It must be a full http or https URL so the components know which server to call. " +
        "Pass the address of your own MarginFront API, including /v1, for example https://billing.example.com/v1.",
    );
  }

  return trimmed.replace(/\/+$/, "");
}
