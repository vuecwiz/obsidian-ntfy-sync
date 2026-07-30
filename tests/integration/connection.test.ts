import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "../../src/domain/types";
import { NtfyConnectionRunner } from "../../src/transport/ntfy/connection";

describe("ntfy connection runner", () => {
  it("streams, normalizes, accepts and aborts against a local server", async () => {
    let requestedUrl = "";
    let authorization = "";
    const server = createServer((request, response) => {
      requestedUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"event":"open","time":1,"topic":"alpha"}\n');
      response.write(
        '{"event":"message","id":"AbCd123456","time":1785297600,"topic":"alpha","message":"hello"}\n',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let accepted!: (value: IncomingMessage) => void;
    const received = new Promise<IncomingMessage>((resolve) => {
      accepted = resolve;
    });
    const runner = new NtfyConnectionRunner(
      {
        id: "primary",
        name: "test",
        baseUrl: `http://127.0.0.1:${port}`,
        topics: ["alpha"],
        readAuth: { kind: "basic", username: "u", password: "p" },
        mode: "stream",
        pollIntervalSeconds: 1,
        allowInsecureHttp: true,
        initialReplay: { kind: "latest" },
        reconnect: { minMs: 10, maxMs: 20, jitterRatio: 1 },
      },
      1024,
      120,
      {
        accept: async (value) => accepted(value),
        ignored: async () => undefined,
        watermark: () => undefined,
        fault: () => undefined,
      },
    );
    runner.start();
    const value = await received;
    await runner.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(value.body).toBe("hello");
    expect(requestedUrl).toContain("/alpha/json?since=latest");
    expect(authorization).toBe("Basic dTpw");
    expect(runner.telemetry.status).toBe("stopped");
  });

  it("falls back from repeatedly closed streams to overlap poll", async () => {
    let streamRequests = 0;
    let pollRequests = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      if (url.searchParams.get("poll") === "1") {
        pollRequests += 1;
        response.end(
          '{"event":"message","id":"PoLl123456","time":1785297600,"topic":"alpha","message":"fallback"}\n',
        );
      } else {
        streamRequests += 1;
        response.end('{"event":"open","time":1,"topic":"alpha"}\n');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let resolveReceived!: (value: IncomingMessage) => void;
    const received = new Promise<IncomingMessage>((resolve) => {
      resolveReceived = resolve;
    });
    const runner = new NtfyConnectionRunner(
      {
        id: "primary",
        name: "test",
        baseUrl: `http://127.0.0.1:${port}`,
        topics: ["alpha"],
        readAuth: { kind: "none" },
        mode: "auto",
        pollIntervalSeconds: 1,
        allowInsecureHttp: true,
        initialReplay: { kind: "duration", valueSeconds: 300 },
        reconnect: { minMs: 1, maxMs: 2, jitterRatio: 1 },
      },
      1024,
      120,
      {
        accept: async (value) => resolveReceived(value),
        ignored: async () => undefined,
        watermark: () => 1785297600000,
        fault: () => undefined,
      },
    );
    runner.start();
    const value = await received;
    await runner.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(value.body).toBe("fallback");
    expect(streamRequests).toBeGreaterThanOrEqual(3);
    expect(pollRequests).toBeGreaterThanOrEqual(1);
  });

  it("resets prior failures after a stable stream before considering poll fallback", async () => {
    let streamRequests = 0;
    let pollRequests = 0;
    const stableStreamMs = 20;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      if (url.searchParams.get("poll") === "1") {
        pollRequests += 1;
        response.end(
          '{"event":"message","id":"Stable1234","time":1785297600,"topic":"alpha","message":"fallback"}\n',
        );
        return;
      }

      streamRequests += 1;
      response.write('{"event":"open","time":1,"topic":"alpha"}\n');
      if (streamRequests === 3) {
        setTimeout(() => response.end(), stableStreamMs + 10);
      } else {
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let resolveReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const runner = new NtfyConnectionRunner(
      { ...connectionConfig(port, "stream"), mode: "auto" },
      1024,
      120,
      {
        accept: async () => resolveReceived(),
        ignored: async () => undefined,
        watermark: () => undefined,
        fault: () => undefined,
      },
      stableStreamMs,
    );

    runner.start();
    await received;
    await runner.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(streamRequests).toBe(5);
    expect(pollRequests).toBe(1);
  });

  it("polls multiple topics with bearer auth, overlap replay, same-second messages and duplicates", async () => {
    let requestedUrl = "";
    let authorization = "";
    const server = createServer((request, response) => {
      requestedUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(
        [
          '{"event":"message","id":"SameSec001","time":1785297600,"topic":"alpha","message":"one"}',
          '{"event":"message","id":"SameSec002","time":1785297600,"topic":"beta","message":"two"}',
          '{"event":"message","id":"SameSec001","time":1785297600,"topic":"alpha","message":"one"}',
        ].join("\n") + "\n",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const accepted: IncomingMessage[] = [];
    let resolveReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const runner = new NtfyConnectionRunner(
      {
        id: "multi",
        name: "multi-topic test",
        baseUrl: `http://127.0.0.1:${port}`,
        topics: ["alpha", "beta"],
        readAuth: { kind: "bearer", token: "fixture-token" },
        mode: "poll",
        pollIntervalSeconds: 60,
        allowInsecureHttp: true,
        initialReplay: { kind: "latest" },
        reconnect: { minMs: 1, maxMs: 2, jitterRatio: 1 },
      },
      1024,
      120,
      {
        accept: async (value) => {
          accepted.push(value);
          if (accepted.length === 3) resolveReceived();
        },
        ignored: async () => undefined,
        watermark: () => 1_785_297_600_000,
        fault: () => undefined,
      },
    );
    runner.start();
    await received;
    await runner.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(requestedUrl).toContain("/alpha,beta/json");
    expect(requestedUrl).toContain("since=1785297480");
    expect(requestedUrl).toContain("poll=1");
    expect(authorization).toBe("Bearer fixture-token");
    expect(new Set(accepted.map((message) => message.key)).size).toBe(2);
    expect(new Set(accepted.map((message) => message.source.topic))).toEqual(
      new Set(["alpha", "beta"]),
    );
  });

  it.each([401, 403])("stops without a retry loop after HTTP %i", async (status) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(status).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let resolveFault!: (code: string) => void;
    const fault = new Promise<string>((resolve) => {
      resolveFault = resolve;
    });
    const runner = new NtfyConnectionRunner(connectionConfig(port, "stream"), 1024, 120, {
      accept: async () => undefined,
      ignored: async () => undefined,
      watermark: () => undefined,
      fault: (value) => resolveFault(value.code),
    });
    runner.start();
    expect(await fault).toBe("AUTH_FAILED");
    await runner.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(requests).toBe(1);
    expect(runner.telemetry.status).toBe("stopped");
  });

  it.each([
    [429, "RATE_LIMITED", { "retry-after": "0" }],
    [503, "SERVER_ERROR", {}],
  ] as const)("retries HTTP %i and then resumes streaming", async (status, code, headers) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(status, headers).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        '{"event":"message","id":"Retry12345","time":1785297600,"topic":"alpha","message":"ok"}\n',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let resolveReceived!: (message: IncomingMessage) => void;
    const received = new Promise<IncomingMessage>((resolve) => {
      resolveReceived = resolve;
    });
    const faults: string[] = [];
    const runner = new NtfyConnectionRunner(connectionConfig(port, "stream"), 1024, 120, {
      accept: async (message) => resolveReceived(message),
      ignored: async () => undefined,
      watermark: () => undefined,
      fault: (value) => faults.push(value.code),
    });
    runner.start();
    expect((await received).body).toBe("ok");
    await runner.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(requests).toBe(2);
    expect(faults).toEqual([code]);
  });

  it("uses poll when an auto-mode response body is not streamable", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    try {
      globalThis.fetch = vi.fn(async (input) => {
        urls.push(String(input));
        if (urls.length === 1) return new Response(null, { status: 200 });
        return new Response(
          '{"event":"message","id":"NoBody1234","time":1785297600,"topic":"alpha","message":"polled"}\n',
          { status: 200 },
        );
      }) as typeof fetch;
      let resolveReceived!: (message: IncomingMessage) => void;
      const received = new Promise<IncomingMessage>((resolve) => {
        resolveReceived = resolve;
      });
      const runner = new NtfyConnectionRunner(
        { ...connectionConfig(12345, "stream"), mode: "auto" },
        1024,
        120,
        {
          accept: async (message) => resolveReceived(message),
          ignored: async () => undefined,
          watermark: () => undefined,
          fault: () => undefined,
        },
      );
      runner.start();
      expect((await received).body).toBe("polled");
      await runner.stop();
      expect(urls).toHaveLength(2);
      expect(urls[1]).toContain("poll=1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("supports initialReplay=all and an already-aborted parent signal", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    try {
      globalThis.fetch = vi.fn(async (input) => {
        urls.push(String(input));
        return new Response(
          '{"event":"message","id":"ReplayAll1","time":1785297600,"topic":"alpha","message":"all"}\n',
          { status: 200 },
        );
      }) as typeof fetch;
      let resolveReceived!: () => void;
      const received = new Promise<void>((resolve) => {
        resolveReceived = resolve;
      });
      const runner = new NtfyConnectionRunner(
        {
          ...connectionConfig(12345, "poll"),
          initialReplay: { kind: "all" },
        },
        1024,
        120,
        {
          accept: async () => resolveReceived(),
          ignored: async () => undefined,
          watermark: () => undefined,
          fault: () => undefined,
        },
      );
      runner.start();
      await received;
      await runner.stop();
      expect(urls[0]).toContain("since=all");

      const aborted = new AbortController();
      aborted.abort();
      const stopped = new NtfyConnectionRunner(connectionConfig(12345, "stream"), 1024, 120, {
        accept: async () => undefined,
        ignored: async () => undefined,
        watermark: () => undefined,
        fault: () => undefined,
      });
      stopped.start(aborted.signal);
      await stopped.stop();
      expect(urls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function connectionConfig(port: number, mode: "stream" | "poll") {
  return {
    id: "status",
    name: "status test",
    baseUrl: `http://127.0.0.1:${port}`,
    topics: ["alpha"],
    readAuth: { kind: "none" as const },
    mode,
    pollIntervalSeconds: 60,
    allowInsecureHttp: true,
    initialReplay: { kind: "latest" as const },
    reconnect: { minMs: 1, maxMs: 2, jitterRatio: 1 },
  };
}
