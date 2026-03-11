import { describe, expect, it } from "vitest";
import { CONFIG_PATH } from "./config.js";
import { FileConfigSource } from "./file-source.js";
import { withTempHomeConfig } from "./test-helpers.js";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

describe("FileConfigSource", () => {
  it("implements ConfigSource interface", () => {
    const source = new FileConfigSource();
    expect(source.watchPath).toBe(CONFIG_PATH);
    expect(source.persistConfig).toBe(true);
    expect(typeof source.read).toBe("function");
    expect(typeof source.startup).toBe("function");
    expect(typeof source.start).toBe("function");
  });

  it("start() returns undefined (no active polling needed)", () => {
    const source = new FileConfigSource();
    const result = source.start(noopLog);
    expect(result).toBeUndefined();
  });

  it("read() returns a valid snapshot for a valid config", async () => {
    await withTempHomeConfig({}, async () => {
      const source = new FileConfigSource();
      const snapshot = await source.read();
      expect(snapshot.exists).toBe(true);
      expect(snapshot.valid).toBe(true);
      expect(snapshot.config).toBeDefined();
    });
  });

  it("startup() returns config for a valid config file", async () => {
    await withTempHomeConfig({}, async () => {
      const source = new FileConfigSource();
      const config = await source.startup(noopLog);
      expect(config).toBeDefined();
      expect(typeof config).toBe("object");
    });
  });
});
