import { AttachmentService } from "../../src/effects/attachment";
import { MemoryVault } from "../helpers/memory-vault";

describe("attachment service", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("blocks external origins and cross-origin redirects", async () => {
    const service = new AttachmentService(new MemoryVault());
    await expect(
      service.downloadSameOrigin(
        "https://external.example/file",
        "https://ntfy.example",
        "a/file",
        100,
        { kind: "none" },
      ),
    ).rejects.toThrow("link-only");

    globalThis.fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://external.example/file" } }),
    ) as typeof fetch;
    await expect(
      service.downloadSameOrigin(
        "https://ntfy.example/file",
        "https://ntfy.example",
        "a/file",
        100,
        { kind: "bearer", token: "secret" },
      ),
    ).rejects.toThrow("Cross-origin");
  });

  it("enforces actual byte limits and writes deterministic output", async () => {
    const vault = new MemoryVault();
    const service = new AttachmentService(vault);
    globalThis.fetch = vi.fn(
      async () => new Response(Uint8Array.from([1, 2, 3, 4])),
    ) as typeof fetch;
    await expect(
      service.downloadSameOrigin(
        "https://ntfy.example/file",
        "https://ntfy.example",
        "a/file.bin",
        3,
        { kind: "none" },
      ),
    ).rejects.toThrow("exceeded");
    expect(vault.binary.size).toBe(0);

    const receipt = await service.downloadSameOrigin(
      "https://ntfy.example/file",
      "https://ntfy.example",
      "a/file.bin",
      10,
      { kind: "none" },
    );
    expect(receipt.bytes).toBe(4);
    expect(await vault.exists("a/file.bin")).toBe(true);
  });

  it("follows bounded same-origin redirects with authorization", async () => {
    const vault = new MemoryVault();
    const service = new AttachmentService(vault);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (requests.length === 1) {
        return new Response(null, { status: 302, headers: { location: "/next" } });
      }
      return new Response(Uint8Array.from([7, 8, 9]), {
        status: 200,
        headers: { "content-length": "3" },
      });
    }) as typeof fetch;
    const receipt = await service.downloadSameOrigin(
      "https://ntfy.example/start",
      "https://ntfy.example",
      "a/file.bin",
      3,
      { kind: "basic", username: "user", password: "fixture-password" },
    );
    expect(requests.map((request) => request.url)).toEqual([
      "https://ntfy.example/start",
      "https://ntfy.example/next",
    ]);
    expect(requests.every((request) => request.authorization?.startsWith("Basic "))).toBe(true);
    expect(receipt.bytes).toBe(3);
  });

  it.each([
    [new Response(null, { status: 302 }), "Redirect has no location"],
    [new Response(null, { status: 401 }), "authorization failed"],
    [new Response(null, { status: 410 }), "unavailable"],
    [new Response(null, { status: 503 }), "Attachment HTTP 503"],
  ])("classifies attachment HTTP failures", async (response, expected) => {
    globalThis.fetch = vi.fn(async () => response) as typeof fetch;
    await expect(
      new AttachmentService(new MemoryVault()).downloadSameOrigin(
        "https://ntfy.example/file",
        "https://ntfy.example",
        "a/file.bin",
        10,
        { kind: "none" },
      ),
    ).rejects.toThrow(expected);
  });

  it("enforces declared length, redirect count and existing-target integrity", async () => {
    const vault = new MemoryVault();
    const service = new AttachmentService(vault);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(Uint8Array.from([1]), {
          status: 200,
          headers: { "content-length": "11" },
        }),
    ) as typeof fetch;
    await expect(
      service.downloadSameOrigin(
        "https://ntfy.example/file",
        "https://ntfy.example",
        "a/file.bin",
        10,
        { kind: "none" },
      ),
    ).rejects.toThrow("configured limit");

    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/again" } }),
    ) as typeof fetch;
    await expect(
      service.downloadSameOrigin(
        "https://ntfy.example/file",
        "https://ntfy.example",
        "a/file.bin",
        10,
        { kind: "none" },
      ),
    ).rejects.toThrow("Too many");

    const bytes = Uint8Array.from([4, 5, 6]);
    await vault.writeBinary("a/file.bin", bytes.buffer);
    globalThis.fetch = vi.fn(async () => new Response(bytes)) as typeof fetch;
    await expect(
      service.downloadSameOrigin(
        "https://ntfy.example/file",
        "https://ntfy.example",
        "a/file.bin",
        10,
        { kind: "none" },
      ),
    ).resolves.toMatchObject({ path: "a/file.bin", bytes: 3 });

    globalThis.fetch = vi.fn(async () => new Response(Uint8Array.from([9]))) as typeof fetch;
    await expect(
      service.downloadSameOrigin(
        "https://ntfy.example/file",
        "https://ntfy.example",
        "a/file.bin",
        10,
        { kind: "none" },
      ),
    ).rejects.toThrow("already exists");
    expect([...vault.binary.keys()].some((path) => path.endsWith(".part"))).toBe(false);
  });
});
