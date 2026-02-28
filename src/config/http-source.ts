import type { ConfigSource, ConfigSourceLog } from "./config-source.js";
import {
  applyModelDefaults,
  applyAgentDefaults,
  applySessionDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyTalkApiKey,
} from "./defaults.js";
import { setRuntimeConfigSnapshot } from "./io.js";
import { normalizeConfigPaths } from "./normalize-paths.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

export type HttpConfigSourceOptions = {
  /** Base URL of the config server (e.g., "http://169.254.169.253"). */
  url: string;
  /** Path to the config endpoint. Default: "/v1/config" */
  configPath?: string;
  /** Path to the version endpoint for polling. Default: "/v1/config-version" */
  versionPath?: string;
  /** Extra headers sent with every request (e.g., auth tokens). */
  headers?: Record<string, string>;
  /** Poll interval in ms for version checking. Default: 5000 */
  pollIntervalMs?: number;
  /** Sentinel file path written on version change. Default: "/tmp/.openclaw-config-changed" */
  sentinelPath?: string;
  /** Label used in snapshot path and error messages. Default: "http" */
  label?: string;
};

const DEFAULT_CONFIG_PATH = "/v1/config";
const DEFAULT_VERSION_PATH = "/v1/config-version";
const DEFAULT_POLL_MS = 5000;
const DEFAULT_SENTINEL = "/tmp/.openclaw-config-changed";

/**
 * HttpConfigSource — fetches config from an HTTP endpoint.
 *
 * Secrets are fetched over HTTP at runtime and held in memory only —
 * they never touch the filesystem. This follows the same pattern as
 * Spring Cloud Config Server, AWS IMDSv2, and GCP Metadata Server.
 *
 * Live reload: polls a version endpoint and writes a sentinel file
 * when the version changes, triggering the gateway's chokidar watcher.
 */
export class HttpConfigSource implements ConfigSource {
  readonly persistConfig = false;
  readonly watchPath: string;

  private readonly url: string;
  private readonly configPath: string;
  private readonly versionPath: string;
  private readonly headers: Record<string, string>;
  private readonly pollIntervalMs: number;
  private readonly label: string;

  constructor(opts: HttpConfigSourceOptions) {
    this.url = opts.url;
    this.configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
    this.versionPath = opts.versionPath ?? DEFAULT_VERSION_PATH;
    this.headers = opts.headers ?? {};
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.watchPath = opts.sentinelPath ?? DEFAULT_SENTINEL;
    this.label = opts.label ?? "http";
  }

  async startup(log: ConfigSourceLog): Promise<OpenClawConfig> {
    log.info(`gateway: loading config from ${this.label} config source`);
    const snapshot = await this.read();
    if (!snapshot.exists) {
      throw new Error(
        `Failed to fetch config from ${this.label} source: ${
          snapshot.issues.map((i) => i.message).join(", ") || "endpoint unreachable"
        }`,
      );
    }
    if (!snapshot.valid) {
      const issues = snapshot.issues
        .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
        .join("\n");
      throw new Error(`Invalid config from ${this.label} source.\n${issues}`);
    }
    log.info(`gateway: config loaded from ${this.label} config source`);
    return snapshot.config;
  }

  async read(): Promise<ConfigFileSnapshot> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${this.configPath}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return failSnapshot(this.label, `${this.label} fetch failed: ${String(err)}`);
    }

    if (!response.ok) {
      return failSnapshot(
        this.label,
        `${this.label} HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ...failSnapshot(this.label, `${this.label} JSON parse error: ${String(err)}`),
        exists: true,
        raw,
      };
    }

    const validated = validateConfigObjectWithPlugins(parsed);
    if (!validated.ok) {
      return {
        path: `<${this.label}>`,
        exists: true,
        raw,
        parsed,
        resolved: {} as OpenClawConfig,
        valid: false,
        config: {} as OpenClawConfig,
        issues: validated.issues,
        warnings: validated.warnings,
        legacyIssues: [],
      };
    }

    const config = normalizeConfigPaths(
      applyTalkApiKey(
        applyModelDefaults(
          applyAgentDefaults(
            applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
          ),
        ),
      ),
    );

    // Update loadConfig() cache so runtime callers see reloaded config
    setRuntimeConfigSnapshot(config);

    return {
      path: `<${this.label}>`,
      exists: true,
      raw,
      parsed,
      resolved: validated.config,
      valid: true,
      config,
      issues: [],
      warnings: validated.warnings,
      legacyIssues: [],
    };
  }

  start(log: ConfigSourceLog): { stop: () => void } {
    let lastVersion = -1;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const sentinelPath = this.watchPath;

    const poll = async () => {
      if (stopped) {
        return;
      }

      try {
        const response = await fetch(`${this.url}${this.versionPath}`, {
          headers: this.headers,
          signal: AbortSignal.timeout(5_000),
        });

        if (!response.ok) {
          log.warn(`config-version: HTTP ${response.status}`);
          return;
        }

        const data = (await response.json()) as { version: number };
        const version = data.version;

        if (lastVersion === -1) {
          lastVersion = version;
          log.info(`config poller started (version=${version})`);
          return;
        }

        if (version !== lastVersion) {
          log.info(`config version changed: ${lastVersion} -> ${version}`);
          lastVersion = version;

          try {
            const { writeFileSync } = await import("node:fs");
            writeFileSync(sentinelPath, String(version), "utf-8");
          } catch (err) {
            log.error(`failed to write sentinel file: ${String(err)}`);
          }
        }
      } catch (err) {
        log.warn(`config-version poll failed: ${String(err)}`);
      }
    };

    void poll();
    timer = setInterval(() => void poll(), this.pollIntervalMs);

    return {
      stop: () => {
        stopped = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
  }
}

function failSnapshot(label: string, message: string): ConfigFileSnapshot {
  return {
    path: `<${label}>`,
    exists: false,
    raw: null,
    parsed: undefined,
    resolved: {} as OpenClawConfig,
    valid: false,
    config: {} as OpenClawConfig,
    issues: [{ path: "", message }],
    warnings: [],
    legacyIssues: [],
  };
}

/**
 * Create an HttpConfigSource from environment variables.
 *
 * Required: OPENCLAW_CONFIG_URL
 * Optional: OPENCLAW_CONFIG_HEADERS (JSON), OPENCLAW_CONFIG_POLL_MS,
 *           OPENCLAW_CONFIG_PATH, OPENCLAW_CONFIG_VERSION_PATH
 */
export function createHttpConfigSourceFromEnv(
  env: Record<string, string | undefined>,
): HttpConfigSource {
  const url = env.OPENCLAW_CONFIG_URL;
  if (!url) {
    throw new Error("OPENCLAW_CONFIG_URL is required when OPENCLAW_CONFIG_SOURCE=http");
  }

  let headers: Record<string, string> | undefined;
  if (env.OPENCLAW_CONFIG_HEADERS) {
    try {
      headers = JSON.parse(env.OPENCLAW_CONFIG_HEADERS) as Record<string, string>;
    } catch {
      throw new Error("OPENCLAW_CONFIG_HEADERS must be valid JSON");
    }
  }

  return new HttpConfigSource({
    url,
    headers,
    pollIntervalMs: env.OPENCLAW_CONFIG_POLL_MS
      ? parseInt(env.OPENCLAW_CONFIG_POLL_MS, 10)
      : undefined,
    configPath: env.OPENCLAW_CONFIG_PATH,
    versionPath: env.OPENCLAW_CONFIG_VERSION_PATH,
  });
}
