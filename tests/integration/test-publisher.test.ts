import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  publishConfiguredMessage,
  publishConfiguredTestMessage,
} from "../../src/app/test-publisher";
import { createDefaultSettings } from "../../src/settings/defaults";

describe("configured test publisher", () => {
  it("publishes plain text to a configured topic with the primary credential", async () => {
    let authorization = "";
    let requestBody = "";
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        requestBody += chunk;
      });
      request.on("end", () => response.writeHead(200).end("{}"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const settings = createDefaultSettings();
      settings.connections = [
        {
          id: "primary",
          name: "test",
          baseUrl: `http://127.0.0.1:${port}`,
          topics: ["alpha"],
          readAuth: { kind: "bearer", token: "fixture-token" },
          mode: "poll",
          pollIntervalSeconds: 30,
          allowInsecureHttp: true,
          initialReplay: { kind: "latest" },
          reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
        },
      ];

      await publishConfiguredTestMessage(settings, {
        topic: "alpha",
        message: "https://example.invalid/clipping",
        priority: 4,
      });

      expect(authorization).toBe("Bearer fixture-token");
      expect(JSON.parse(requestBody)).toEqual({
        topic: "alpha",
        message: "https://example.invalid/clipping",
        priority: 4,
        cache: "yes",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("uploads a Vault file body with filename, priority and optional message headers", async () => {
    let method = "";
    let requestedUrl = "";
    let filename = "";
    let priority = "";
    let message = "";
    const chunks: Buffer[] = [];
    const server = createServer((request, response) => {
      method = request.method ?? "";
      requestedUrl = request.url ?? "";
      filename = String(request.headers["x-filename"] ?? "");
      priority = String(request.headers["x-priority"] ?? "");
      message = String(request.headers["x-message"] ?? "");
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => response.writeHead(200).end("{}"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const settings = createDefaultSettings();
      settings.connections = [
        {
          id: "primary",
          name: "test",
          baseUrl: `http://127.0.0.1:${port}`,
          topics: ["alpha"],
          readAuth: { kind: "none" },
          mode: "poll",
          pollIntervalSeconds: 30,
          allowInsecureHttp: true,
          initialReplay: { kind: "latest" },
          reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
        },
      ];
      const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer;

      await publishConfiguredTestMessage(settings, {
        topic: "alpha",
        message: "image test",
        priority: 5,
        attachment: { name: "example.png", data },
      });

      expect(method).toBe("PUT");
      expect(requestedUrl).toBe("/alpha");
      expect(filename).toBe("example.png");
      expect(priority).toBe("5");
      expect(message).toBe("image test");
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(data));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("publishes the official optional fields to a non-subscribed outbound topic", async () => {
    let requestBody = "";
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        requestBody += chunk;
      });
      request.on("end", () => response.writeHead(200).end("{}"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const settings = createDefaultSettings();
      settings.connections = [
        {
          id: "primary",
          name: "test",
          baseUrl: `http://127.0.0.1:${port}`,
          topics: ["alpha"],
          readAuth: { kind: "none" },
          mode: "poll",
          pollIntervalSeconds: 30,
          allowInsecureHttp: true,
          initialReplay: { kind: "latest" },
          reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
        },
      ];

      await publishConfiguredMessage(settings, {
        topic: "mobile_notifications",
        title: "Build complete",
        message: "Artifacts are ready",
        priority: 4,
        tags: ["white_check_mark", "build"],
        clickUrl: "https://example.com/build/42",
        email: "mobile@example.com",
        delay: "30m",
        markdown: true,
        attachmentUrl: "https://example.com/result.png",
        filename: "result.png",
      });

      expect(JSON.parse(requestBody)).toEqual({
        topic: "mobile_notifications",
        title: "Build complete",
        message: "Artifacts are ready",
        priority: 4,
        tags: ["white_check_mark", "build"],
        click: "https://example.com/build/42",
        email: "mobile@example.com",
        delay: "30m",
        markdown: true,
        attach: "https://example.com/result.png",
        filename: "result.png",
        cache: "yes",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not reuse configured credentials for an unconfigured connection URL", async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      request.resume();
      request.on("end", () => response.writeHead(200).end("{}"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const settings = createDefaultSettings();
      settings.connections = [
        {
          id: "primary",
          name: "configured",
          baseUrl: "https://configured.example",
          topics: ["alpha"],
          readAuth: { kind: "bearer", token: "fixture-token" },
          mode: "poll",
          pollIntervalSeconds: 30,
          allowInsecureHttp: false,
          initialReplay: { kind: "latest" },
          reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
        },
      ];

      await publishConfiguredMessage(settings, {
        baseUrl: `http://127.0.0.1:${port}`,
        topic: "mobile_notifications",
        message: "credential isolation",
        priority: 3,
      });

      expect(authorization).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reuses credentials only when the editable connection matches a configured origin", async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      request.resume();
      request.on("end", () => response.writeHead(200).end("{}"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}`;
      const settings = createDefaultSettings();
      settings.connections = [
        {
          id: "primary",
          name: "configured",
          baseUrl,
          topics: ["alpha"],
          readAuth: { kind: "bearer", token: "fixture-token" },
          mode: "poll",
          pollIntervalSeconds: 30,
          allowInsecureHttp: true,
          initialReplay: { kind: "latest" },
          reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
        },
      ];

      await publishConfiguredMessage(settings, {
        baseUrl: `${baseUrl}/`,
        topic: "mobile_notifications",
        message: "credential reuse",
        priority: 3,
      });

      expect(authorization).toBe("Bearer fixture-token");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
