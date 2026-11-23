/**
 * Update awareness. This package is not published to a registry, so there is
 * nothing to compare against: checkForUpdate() makes no network call and always
 * reports that no update is available. Update by pulling the repository and
 * rebuilding.
 */

import { resolveSdkVersion } from "./utils/http";

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

/** @deprecated Always resolves with updateAvailable: false and never touches the network. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  return { current: resolveSdkVersion(), latest: null, updateAvailable: false };
}
