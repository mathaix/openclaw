import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMetadataConfigSnapshot, startMetadataConfigPoller } from "./metadata-source.js";
import { withEnvOverride } from "./test-helpers.js";

// Minimal valid OpenClaw config (empty object passes zod schema validation)
const VALID_CONFIG = {};

// Helper: create a local HTTP server that serves metadata responses
function createMetadataServer(handlers: {
  config?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  configVersion?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}): Promise<{ url: string; server: http.Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/config" && handlers.config) {
        handlers.config(req, res);
      } else if (req.url === "/v1/config-version" && handlers.configVersion) {
        handlers.configVersion(req, res);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("readMetadataConfigSnapshot", () => {
  let metaServer: Awaited<ReturnType<typeof createMetadataServer>>;

  afterEach(async () => {
    if (metaServer) {
      await metaServer.close();
    }
  });

  it("fetches and validates a valid config", async () => {
    metaServer = await createMetadataServer({
      config: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(VALID_CONFIG));
      },
    });

    const snapshot = await readMetadataConfigSnapshot(metaServer.url);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.path).toBe("<metadata>");
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.config).toBeDefined();
  });

  it("returns exists:false on network error", async () => {
    // Use a port that nothing is listening on
    const snapshot = await readMetadataConfigSnapshot("http://127.0.0.1:1");
    expect(snapshot.exists).toBe(false);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues.length).toBeGreaterThan(0);
    expect(snapshot.issues[0].message).toContain("metadata fetch failed");
  });

  it("returns exists:false on HTTP error", async () => {
    metaServer = await createMetadataServer({
      config: (_req, res) => {
        res.writeHead(500);
        res.end("Internal Server Error");
      },
    });

    const snapshot = await readMetadataConfigSnapshot(metaServer.url);
    expect(snapshot.exists).toBe(false);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues[0].message).toContain("metadata HTTP 500");
  });

  it("returns valid:false on invalid JSON", async () => {
    metaServer = await createMetadataServer({
      config: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not json {{{");
      },
    });

    const snapshot = await readMetadataConfigSnapshot(metaServer.url);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues[0].message).toContain("JSON parse error");
  });

  it("sends X-Metadata-Nonce header when OCM_METADATA_NONCE is set", async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};

    metaServer = await createMetadataServer({
      config: (req, res) => {
        capturedHeaders = req.headers;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(VALID_CONFIG));
      },
    });

    await withEnvOverride({ OCM_METADATA_NONCE: "test-nonce-123" }, async () => {
      await readMetadataConfigSnapshot(metaServer.url);
    });

    expect(capturedHeaders["x-metadata-nonce"]).toBe("test-nonce-123");
  });

  it("does not send nonce header when OCM_METADATA_NONCE is unset", async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};

    metaServer = await createMetadataServer({
      config: (req, res) => {
        capturedHeaders = req.headers;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(VALID_CONFIG));
      },
    });

    await withEnvOverride({ OCM_METADATA_NONCE: undefined }, async () => {
      await readMetadataConfigSnapshot(metaServer.url);
    });

    expect(capturedHeaders["x-metadata-nonce"]).toBeUndefined();
  });

  it("applies runtime defaults to valid config", async () => {
    metaServer = await createMetadataServer({
      config: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(VALID_CONFIG));
      },
    });

    const snapshot = await readMetadataConfigSnapshot(metaServer.url);
    expect(snapshot.valid).toBe(true);
    // Runtime defaults should be applied (e.g., logging defaults)
    expect(snapshot.config).toBeDefined();
    // resolved should be the pre-defaults version
    expect(snapshot.resolved).toBeDefined();
  });

  it("sets legacyIssues to empty array", async () => {
    metaServer = await createMetadataServer({
      config: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(VALID_CONFIG));
      },
    });

    const snapshot = await readMetadataConfigSnapshot(metaServer.url);
    // Metadata configs never have legacy issues (no migration needed)
    expect(snapshot.legacyIssues).toEqual([]);
  });
});

describe("startMetadataConfigPoller", () => {
  let metaServer: Awaited<ReturnType<typeof createMetadataServer>>;
  let tmpDir: string;
  let poller: { stop: () => void } | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-poller-test-"));
  });

  afterEach(async () => {
    if (poller) {
      poller.stop();
      poller = null;
    }
    if (metaServer) {
      await metaServer.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records initial version without writing sentinel", async () => {
    const logs: string[] = [];
    const sentinelPath = path.join(tmpDir, "sentinel");

    metaServer = await createMetadataServer({
      configVersion: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: 1 }));
      },
    });

    poller = startMetadataConfigPoller({
      metadataUrl: metaServer.url,
      pollIntervalMs: 50,
      sentinelPath,
      log: {
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(`WARN: ${msg}`),
        error: (msg) => logs.push(`ERROR: ${msg}`),
      },
    });

    // Wait for first poll
    await new Promise((r) => setTimeout(r, 100));

    expect(logs.some((l) => l.includes("poller started"))).toBe(true);
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it("writes sentinel file when version changes", async () => {
    let currentVersion = 1;
    const logs: string[] = [];
    const sentinelPath = path.join(tmpDir, "sentinel");

    metaServer = await createMetadataServer({
      configVersion: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: currentVersion }));
      },
    });

    poller = startMetadataConfigPoller({
      metadataUrl: metaServer.url,
      pollIntervalMs: 50,
      sentinelPath,
      log: {
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(`WARN: ${msg}`),
        error: (msg) => logs.push(`ERROR: ${msg}`),
      },
    });

    // Wait for initial poll
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(sentinelPath)).toBe(false);

    // Change version
    currentVersion = 2;
    await new Promise((r) => setTimeout(r, 100));

    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(fs.readFileSync(sentinelPath, "utf-8")).toBe("2");
    expect(logs.some((l) => l.includes("version changed: 1 -> 2"))).toBe(true);
  });

  it("does not write sentinel when version is unchanged", async () => {
    const logs: string[] = [];
    const sentinelPath = path.join(tmpDir, "sentinel");

    metaServer = await createMetadataServer({
      configVersion: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: 42 }));
      },
    });

    poller = startMetadataConfigPoller({
      metadataUrl: metaServer.url,
      pollIntervalMs: 50,
      sentinelPath,
      log: {
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(`WARN: ${msg}`),
        error: (msg) => logs.push(`ERROR: ${msg}`),
      },
    });

    // Wait for several polls
    await new Promise((r) => setTimeout(r, 200));

    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(logs.filter((l) => l.includes("version changed")).length).toBe(0);
  });

  it("logs warning on HTTP error without crashing", async () => {
    const logs: string[] = [];
    const sentinelPath = path.join(tmpDir, "sentinel");

    metaServer = await createMetadataServer({
      configVersion: (_req, res) => {
        res.writeHead(503);
        res.end("Service Unavailable");
      },
    });

    poller = startMetadataConfigPoller({
      metadataUrl: metaServer.url,
      pollIntervalMs: 50,
      sentinelPath,
      log: {
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(`WARN: ${msg}`),
        error: (msg) => logs.push(`ERROR: ${msg}`),
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(logs.some((l) => l.includes("WARN") && l.includes("503"))).toBe(true);
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it("logs warning on network error without crashing", async () => {
    const logs: string[] = [];
    const sentinelPath = path.join(tmpDir, "sentinel");

    poller = startMetadataConfigPoller({
      metadataUrl: "http://127.0.0.1:1",
      pollIntervalMs: 50,
      sentinelPath,
      log: {
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(`WARN: ${msg}`),
        error: (msg) => logs.push(`ERROR: ${msg}`),
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(logs.some((l) => l.includes("WARN") && l.includes("poll failed"))).toBe(true);
  });

  it("stop() prevents further polling", async () => {
    let pollCount = 0;
    const logs: string[] = [];
    const sentinelPath = path.join(tmpDir, "sentinel");

    metaServer = await createMetadataServer({
      configVersion: (_req, res) => {
        pollCount++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: 1 })); // constant version — no sentinel writes
      },
    });

    poller = startMetadataConfigPoller({
      metadataUrl: metaServer.url,
      pollIntervalMs: 50,
      sentinelPath,
      log: {
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(`WARN: ${msg}`),
        error: (msg) => logs.push(`ERROR: ${msg}`),
      },
    });

    // Wait for a few polls, then stop
    await new Promise((r) => setTimeout(r, 200));
    poller.stop();
    poller = null;
    const countAtStop = pollCount;

    // Wait and verify no more polls happen
    await new Promise((r) => setTimeout(r, 200));
    expect(pollCount).toBe(countAtStop);
  });
});
