/**
 * Backward-compatible re-exports from HttpConfigSource.
 *
 * The original readMetadataConfigSnapshot and startMetadataConfigPoller
 * functions have been refactored into the HttpConfigSource class.
 * These wrappers preserve the existing function signatures for
 * callers and tests that haven't migrated yet.
 */

import type { ConfigSourceLog } from "./config-source.js";
import { HttpConfigSource } from "./http-source.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

/**
 * Fetch config from an HTTP metadata endpoint.
 * @deprecated Use HttpConfigSource.read() instead.
 */
export async function readMetadataConfigSnapshot(metadataUrl: string): Promise<ConfigFileSnapshot> {
  const nonce = process.env.OCM_METADATA_NONCE || "";
  const source = new HttpConfigSource({
    url: metadataUrl,
    headers: nonce ? { "X-Metadata-Nonce": nonce } : {},
    label: "metadata",
  });
  return source.read();
}

/**
 * Start a poller that checks /v1/config-version and writes a sentinel file.
 * @deprecated Use HttpConfigSource.start() instead.
 */
export function startMetadataConfigPoller(opts: {
  metadataUrl: string;
  pollIntervalMs?: number;
  sentinelPath?: string;
  log: ConfigSourceLog;
}): { stop: () => void } {
  const nonce = process.env.OCM_METADATA_NONCE || "";
  const source = new HttpConfigSource({
    url: opts.metadataUrl,
    headers: nonce ? { "X-Metadata-Nonce": nonce } : {},
    pollIntervalMs: opts.pollIntervalMs,
    sentinelPath: opts.sentinelPath,
    label: "metadata",
  });
  return source.start(opts.log);
}
