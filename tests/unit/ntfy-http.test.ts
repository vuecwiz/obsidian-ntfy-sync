import { ntfyPublishMessage, ntfyPublishUserMessage } from "../../src/transport/ntfy/http";

describe("ntfy publish HTTP", () => {
  it("uses one redirect-blocking fetch request", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;
    try {
      await ntfyPublishMessage(
        "https://ntfy.example",
        "alpha",
        { kind: "bearer", token: "fixture-token" },
        "hello",
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0];
    const requestInit = request?.[1];
    if (!request || !requestInit) throw new Error("publish fetch call is missing");
    expect(request[0]).toBe("https://ntfy.example");
    expect(requestInit).toMatchObject({ method: "POST", redirect: "error" });
    expect((requestInit.headers as Headers).get("Authorization")).toBe("Bearer fixture-token");
    expect(JSON.parse(String(requestInit.body))).toEqual({
      topic: "alpha",
      message: "hello",
      cache: "yes",
    });
  });

  it("encodes attachment title and tags into finite publish headers", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;
    try {
      await ntfyPublishUserMessage(
        "https://ntfy.example",
        "alpha",
        { kind: "none" },
        {
          title: "Build complete",
          message: "See attachment",
          priority: 5,
          tags: ["white_check_mark", "build"],
          clickUrl: "https://example.com/build/42",
          email: "mobile@example.com",
          delay: "30m",
          markdown: true,
          filename: "build-result.txt",
          attachment: { name: "result.txt", data: new TextEncoder().encode("ok").buffer },
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const requestInit = fetchMock.mock.calls[0]?.[1];
    if (!requestInit) throw new Error("publish fetch call is missing");
    const headers = requestInit.headers as Headers;
    expect(headers.get("X-Title")).toBe("Build complete");
    expect(headers.get("X-Tags")).toBe("white_check_mark,build");
    expect(headers.get("X-Priority")).toBe("5");
    expect(headers.get("X-Filename")).toBe("build-result.txt");
    expect(headers.get("X-Click")).toBe("https://example.com/build/42");
    expect(headers.get("X-Email")).toBe("mobile@example.com");
    expect(headers.get("X-Delay")).toBe("30m");
    expect(headers.get("X-Markdown")).toBe("true");
  });

  it("maps optional notification fields into the JSON publish schema", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;
    try {
      await ntfyPublishUserMessage(
        "https://ntfy.example",
        "alpha",
        { kind: "none" },
        {
          title: "Build complete",
          message: "[Open build](https://example.com/build/42)",
          priority: 4,
          tags: ["build"],
          clickUrl: "https://example.com/build/42",
          email: "mobile@example.com",
          delay: "30m",
          markdown: true,
          attachmentUrl: "https://example.com/result.png",
          filename: "result.png",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const requestInit = fetchMock.mock.calls[0]?.[1];
    if (!requestInit) throw new Error("publish fetch call is missing");
    expect(JSON.parse(String(requestInit.body))).toEqual({
      topic: "alpha",
      title: "Build complete",
      message: "[Open build](https://example.com/build/42)",
      priority: 4,
      tags: ["build"],
      click: "https://example.com/build/42",
      email: "mobile@example.com",
      delay: "30m",
      markdown: true,
      attach: "https://example.com/result.png",
      filename: "result.png",
      cache: "yes",
    });
  });

  it("omits priority when the composer leaves the optional field unset", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;
    try {
      await ntfyPublishUserMessage(
        "https://ntfy.example",
        "alpha",
        { kind: "none" },
        { message: "default priority", tags: [] },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const requestInit = fetchMock.mock.calls[0]?.[1];
    if (!requestInit) throw new Error("publish fetch call is missing");
    expect(JSON.parse(String(requestInit.body))).toEqual({
      topic: "alpha",
      message: "default priority",
      cache: "yes",
    });
  });

  it("passes the abort signal to the only publish request", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });
    globalThis.fetch = fetchMock;
    try {
      const publishing = ntfyPublishMessage(
        "https://ntfy.example",
        "alpha",
        { kind: "none" },
        "cancel me",
        true,
        controller.signal,
      );
      controller.abort();

      await expect(publishing).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry when the send result is uncertain", async () => {
    const originalFetch = globalThis.fetch;
    const uncertainFailure = new TypeError("connection reset while reading response");
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(uncertainFailure);
    globalThis.fetch = fetchMock;
    try {
      await expect(
        ntfyPublishMessage("https://ntfy.example", "alpha", { kind: "none" }, "send once", true),
      ).rejects.toBe(uncertainFailure);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
