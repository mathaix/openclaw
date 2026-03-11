import http from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { HttpConfigSource, createHttpConfigSourceFromEnv } from "./http-source.js";

const VALID_CONFIG = {};

function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{
  url: string;
  server: http.Server;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
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

describe("HttpConfigSource", () => {
  let testServer: Awaited<ReturnType<typeof createTestServer>> | null = null;

  afterEach(async () => {
    if (testServer) {
      await testServer.close();
      testServer = null;
    }
  });

  it("defaults label to 'http' in snapshot path", async () => {
    testServer = await createTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(VALID_CONFIG));
    });

    const source = new HttpConfigSource({ url: testServer.url });
    const snapshot = await source.read();

    expect(snapshot.path).toBe("<http>");
    expect(snapshot.valid).toBe(true);
  });

  it("uses custom label in snapshot path", async () => {
    testServer = await createTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(VALID_CONFIG));
    });

    const source = new HttpConfigSource({ url: testServer.url, label: "imds" });
    const snapshot = await source.read();

    expect(snapshot.path).toBe("<imds>");
  });

  it("uses custom label in error messages", async () => {
    const source = new HttpConfigSource({ url: "http://127.0.0.1:1", label: "myservice" });
    const snapshot = await source.read();

    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues[0].message).toContain("myservice fetch failed");
  });

  it("uses custom configPath", async () => {
    let requestedPath = "";
    testServer = await createTestServer((req, res) => {
      requestedPath = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(VALID_CONFIG));
    });

    const source = new HttpConfigSource({ url: testServer.url, configPath: "/custom/config" });
    await source.read();

    expect(requestedPath).toBe("/custom/config");
  });

  it("sends custom headers", async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    testServer = await createTestServer((req, res) => {
      capturedHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(VALID_CONFIG));
    });

    const source = new HttpConfigSource({
      url: testServer.url,
      headers: { "X-Custom": "test-value", Authorization: "Bearer tok" },
    });
    await source.read();

    expect(capturedHeaders["x-custom"]).toBe("test-value");
    expect(capturedHeaders["authorization"]).toBe("Bearer tok");
  });

  it("persistConfig is false", () => {
    const source = new HttpConfigSource({ url: "http://localhost" });
    expect(source.persistConfig).toBe(false);
  });

  it("watchPath defaults to sentinel path", () => {
    const source = new HttpConfigSource({ url: "http://localhost" });
    expect(source.watchPath).toBe("/tmp/.openclaw-config-changed");
  });

  it("watchPath uses custom sentinelPath", () => {
    const source = new HttpConfigSource({
      url: "http://localhost",
      sentinelPath: "/tmp/my-sentinel",
    });
    expect(source.watchPath).toBe("/tmp/my-sentinel");
  });

  it("startup() returns config on success", async () => {
    testServer = await createTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(VALID_CONFIG));
    });

    const logs: string[] = [];
    const log = {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(`WARN: ${msg}`),
      error: (msg: string) => logs.push(`ERROR: ${msg}`),
    };

    const source = new HttpConfigSource({ url: testServer.url });
    const config = await source.startup(log);
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");
    expect(logs.some((l) => l.includes("loading config"))).toBe(true);
    expect(logs.some((l) => l.includes("config loaded"))).toBe(true);
  });

  it("startup() throws on network error", async () => {
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const source = new HttpConfigSource({ url: "http://127.0.0.1:1" });
    await expect(source.startup(log)).rejects.toThrow("Failed to fetch config");
  });

  it("startup() throws on invalid config", async () => {
    testServer = await createTestServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });

    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const source = new HttpConfigSource({ url: testServer.url });
    await expect(source.startup(log)).rejects.toThrow("Failed to fetch config");
  });
});

describe("createHttpConfigSourceFromEnv", () => {
  it("throws when OPENCLAW_CONFIG_URL is missing", () => {
    expect(() => createHttpConfigSourceFromEnv({})).toThrow("OPENCLAW_CONFIG_URL is required");
  });

  it("creates source from minimal env", () => {
    const source = createHttpConfigSourceFromEnv({
      OPENCLAW_CONFIG_URL: "http://169.254.169.253",
    });
    expect(source).toBeInstanceOf(HttpConfigSource);
    expect(source.persistConfig).toBe(false);
  });

  it("parses OPENCLAW_CONFIG_HEADERS as JSON", async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};

    const server = await createTestServer((req, res) => {
      capturedHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(VALID_CONFIG));
    });

    try {
      const source = createHttpConfigSourceFromEnv({
        OPENCLAW_CONFIG_URL: server.url,
        OPENCLAW_CONFIG_HEADERS: JSON.stringify({ "X-Token": "secret" }),
      });
      await source.read();
      expect(capturedHeaders["x-token"]).toBe("secret");
    } finally {
      await server.close();
    }
  });

  it("throws on invalid OPENCLAW_CONFIG_HEADERS JSON", () => {
    expect(() =>
      createHttpConfigSourceFromEnv({
        OPENCLAW_CONFIG_URL: "http://localhost",
        OPENCLAW_CONFIG_HEADERS: "not-json",
      }),
    ).toThrow("OPENCLAW_CONFIG_HEADERS must be valid JSON");
  });

  it("passes custom paths and poll interval", () => {
    const source = createHttpConfigSourceFromEnv({
      OPENCLAW_CONFIG_URL: "http://localhost",
      OPENCLAW_CONFIG_PATH: "/custom/config",
      OPENCLAW_CONFIG_VERSION_PATH: "/custom/version",
      OPENCLAW_CONFIG_POLL_MS: "10000",
    });
    expect(source).toBeInstanceOf(HttpConfigSource);
  });
});
