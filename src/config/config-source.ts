import type { OpenClawConfig } from "./types.openclaw.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

/**
 * Log interface for config source operations.
 */
export type ConfigSourceLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/**
 * A ConfigSource reads configuration and provides reload mechanics.
 *
 * This is the strategy interface for config loading — implementations decide
 * where config comes from (local file, HTTP endpoint, etc.) while the gateway
 * only depends on this interface.
 *
 * Config loads before plugins (plugins need config to initialize), so this
 * is a core abstraction, not a plugin extension point.
 */
export interface ConfigSource {
  /**
   * One-time startup: run source-specific initialization and return the
   * initial config. File sources use this for legacy migration and plugin
   * auto-enable; HTTP sources use this to fetch and validate.
   *
   * Called once at gateway boot, before plugins load.
   */
  startup(log: ConfigSourceLog): Promise<OpenClawConfig>;

  /**
   * Read the current configuration snapshot.
   * Called on each reload trigger (not at startup — use startup() for that).
   */
  read(): Promise<ConfigFileSnapshot>;

  /**
   * Path that the gateway config reloader watches with chokidar.
   * For file sources, this is the config file path.
   * For HTTP sources, this is a sentinel file written by the poller.
   */
  readonly watchPath: string;

  /**
   * Optional setup called after the gateway starts the config reloader.
   * HTTP sources use this to start a version poller.
   * File sources don't need this (chokidar watches the file directly).
   * Returns a cleanup function, or undefined if no setup was needed.
   */
  start?(log: ConfigSourceLog): { stop: () => void } | undefined;

  /**
   * Whether the gateway should persist generated auth tokens to the config.
   * File sources return true (can write back). HTTP sources return false.
   */
  readonly persistConfig: boolean;
}
