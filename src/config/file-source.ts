import { formatCliCommand } from "../cli/command-format.js";
import type { ConfigSource, ConfigSourceLog } from "./config-source.js";
import {
  CONFIG_PATH,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

/**
 * FileConfigSource — loads config from the local filesystem.
 *
 * This is the default config source. It extracts the existing file-based
 * config loading logic from server.impl.ts into the ConfigSource interface.
 *
 * Includes: legacy migration, plugin auto-enable on first read.
 * Zero behavior change for existing users.
 */
export class FileConfigSource implements ConfigSource {
  readonly watchPath = CONFIG_PATH;
  readonly persistConfig = true;

  private log: ConfigSourceLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  /**
   * One-time startup: run legacy migration, plugin auto-enable, and
   * return the config with full runtime defaults applied.
   */
  async startup(log: ConfigSourceLog): Promise<OpenClawConfig> {
    this.log = log;
    await this.prepareOnFirstRead();
    return loadConfig();
  }

  async read(): Promise<ConfigFileSnapshot> {
    return readConfigFileSnapshot();
  }

  start(log: ConfigSourceLog): undefined {
    this.log = log;
    return undefined;
  }

  /**
   * File-specific first-read tasks: legacy migration and plugin auto-enable.
   */
  private async prepareOnFirstRead(): Promise<void> {
    let snapshot = await readConfigFileSnapshot();

    // Legacy migration
    if (snapshot.legacyIssues.length > 0) {
      if (isNixMode) {
        throw new Error(
          "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
        );
      }
      const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
      if (!migrated) {
        throw new Error(
          `Legacy config entries detected but auto-migration failed. Run "${formatCliCommand("openclaw doctor")}" to migrate.`,
        );
      }
      await writeConfigFile(migrated);
      if (changes.length > 0) {
        this.log.info(
          `gateway: migrated legacy config entries:\n${changes.map((entry) => `- ${entry}`).join("\n")}`,
        );
      }
    }

    // Re-read after potential migration and validate
    snapshot = await readConfigFileSnapshot();
    if (snapshot.exists && !snapshot.valid) {
      const issues =
        snapshot.issues.length > 0
          ? snapshot.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("\n")
          : "Unknown validation issue.";
      throw new Error(
        `Invalid config at ${snapshot.path}.\n${issues}\nRun "${formatCliCommand("openclaw doctor")}" to repair, then retry.`,
      );
    }

    // Plugin auto-enable
    const autoEnable = applyPluginAutoEnable({ config: snapshot.config, env: process.env });
    if (autoEnable.changes.length > 0) {
      try {
        await writeConfigFile(autoEnable.config);
        this.log.info(
          `gateway: auto-enabled plugins:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`,
        );
      } catch (err) {
        this.log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
      }
    }
  }
}
