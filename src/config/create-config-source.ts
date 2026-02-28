import type { ConfigSource } from "./config-source.js";
import { FileConfigSource } from "./file-source.js";
import { HttpConfigSource, createHttpConfigSourceFromEnv } from "./http-source.js";

/**
 * Create a ConfigSource based on environment variables.
 *
 * Two env var conventions are supported:
 *
 *   OPENCLAW_CONFIG_SOURCE=http  → generic HTTP config source
 *     Uses OPENCLAW_CONFIG_URL, OPENCLAW_CONFIG_HEADERS, etc.
 *
 *   OCM_CONFIG_SOURCE=metadata   → IMDSv2-style metadata endpoint
 *     Uses OCM_METADATA_URL, OCM_METADATA_NONCE (legacy/internal)
 *
 *   (unset)                      → FileConfigSource (local file, default)
 */
export function createConfigSource(env: Record<string, string | undefined>): ConfigSource {
  // Generic HTTP source (upstream convention)
  if (env.OPENCLAW_CONFIG_SOURCE === "http") {
    console.log("[config-source] using HTTP config source (OPENCLAW_CONFIG_SOURCE=http)");
    return createHttpConfigSourceFromEnv(env);
  }

  // IMDSv2-style metadata source (internal convention)
  if (env.OCM_CONFIG_SOURCE === "metadata") {
    const metadataUrl = env.OCM_METADATA_URL || "http://169.254.169.253";
    const nonce = env.OCM_METADATA_NONCE || "";
    console.log(`[config-source] using metadata config source (url=${metadataUrl})`);
    return new HttpConfigSource({
      url: metadataUrl,
      headers: nonce ? { "X-Metadata-Nonce": nonce } : {},
      label: "metadata",
    });
  }

  console.log("[config-source] using file config source (default)");
  return new FileConfigSource();
}
