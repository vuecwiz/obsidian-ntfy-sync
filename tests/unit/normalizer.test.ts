import {
  canonicalServerOrigin,
  extractFirstUrl,
  normalizeMessage,
  sourceKey,
} from "../../src/transport/ntfy/normalizer";

describe("ntfy normalizer", () => {
  it("normalizes defaults, URLs and unknown fields", () => {
    const normalized = normalizeMessage(
      {
        event: "message",
        id: "AbCd123456",
        time: 1785297600,
        topic: "topic",
        message: "see https://例子.测试/path?secret=1",
        future: true,
      },
      "primary",
      "https://ntfy.example",
      123,
    );
    expect(normalized.priority).toBe(3);
    expect(normalized.firstUrl?.protocol).toBe("https:");
    expect(normalized.firstUrl?.hostname).toMatch(/^xn--/);
    expect(normalized.unknownFields).toEqual(["future"]);
  });

  it("rejects missing identity, bad priority and oversized body", () => {
    expect(() =>
      normalizeMessage({ event: "message", time: 1, topic: "t" }, "c", "https://x", 0),
    ).toThrow("id");
    expect(() =>
      normalizeMessage(
        { event: "message", id: "i", time: 1, topic: "t", message: "", priority: 9 },
        "c",
        "https://x",
        0,
      ),
    ).toThrow("priority");
    expect(() =>
      normalizeMessage(
        { event: "message", id: "i", time: 1, topic: "t", message: "abcd" },
        "c",
        "https://x",
        0,
        3,
      ),
    ).toThrow("configured limit");
  });

  it("requires a string body for message events while accepting an empty body", () => {
    const base = { event: "message", id: "Body123456", time: 1, topic: "topic" };
    expect(() => normalizeMessage(base, "c", "https://x", 0)).toThrow("message");
    expect(() => normalizeMessage({ ...base, message: 42 }, "c", "https://x", 0)).toThrow(
      "message",
    );
    expect(normalizeMessage({ ...base, message: "" }, "c", "https://x", 0).body).toBe("");
  });

  it("canonicalizes origins and only permits loopback HTTP when explicit", () => {
    expect(canonicalServerOrigin("https://NTFY.example/path/")).toBe("https://ntfy.example/path");
    expect(() => canonicalServerOrigin("http://example.com", true)).toThrow("HTTPS");
    expect(canonicalServerOrigin("http://127.0.0.1:8080", true)).toBe("http://127.0.0.1:8080");
  });

  it("uses stable server/topic/id source identity", () => {
    expect(sourceKey("https://a", "topic", "id")).toBe(sourceKey("https://a", "topic", "id"));
    expect(sourceKey("https://a", "topic", "id")).not.toBe(sourceKey("https://b", "topic", "id"));
  });

  it("does not treat punctuation as part of the first URL", () => {
    expect(extractFirstUrl("see (https://github.com/owner/repo).")?.raw).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("normalizes optional protocol fields and attachment metadata", () => {
    const normalized = normalizeMessage(
      {
        event: "message",
        id: "Full123456",
        time: 10,
        expires: 20,
        topic: "topic",
        title: "title",
        message: "body",
        tags: ["one", "two"],
        priority: 5,
        click: "https://example.test/click",
        content_type: "text/markdown",
        sequence_id: "sequence",
        attachment: {
          name: "file.txt",
          url: "https://ntfy.example/file",
          type: "text/plain",
          size: 3,
          expires: 30,
        },
      },
      "primary",
      "https://ntfy.example",
      40,
    );
    expect(normalized).toMatchObject({
      expiresAtMs: 20_000,
      priority: 5,
      tags: ["one", "two"],
      contentType: "text/markdown",
      source: { sequenceId: "sequence" },
      attachment: { size: 3, expiresAtMs: 30_000 },
    });
  });

  it("rejects malformed optional protocol fields", () => {
    const base = {
      event: "message",
      id: "Bad123456",
      time: 1,
      topic: "topic",
      message: "body",
    };
    expect(() => normalizeMessage({ ...base, tags: [1] }, "c", "https://x", 0)).toThrow("tags");
    expect(() => normalizeMessage({ ...base, expires: -1 }, "c", "https://x", 0)).toThrow(
      "expires",
    );
    expect(() => normalizeMessage({ ...base, attachment: "bad" }, "c", "https://x", 0)).toThrow(
      "attachment",
    );
    expect(() =>
      normalizeMessage(
        { ...base, attachment: { name: "", url: "https://x/file" } },
        "c",
        "https://x",
        0,
      ),
    ).toThrow("attachment.name");
  });

  it("strips URL credentials/query/fragment and supports explicit localhost HTTP", () => {
    const credentialUrl = ["https://user", "fixture@example.com/base/?token=x#fragment"].join(":");
    expect(canonicalServerOrigin(credentialUrl)).toBe("https://example.com/base");
    expect(canonicalServerOrigin("http://localhost:8080", true)).toBe("http://localhost:8080");
    expect(() => canonicalServerOrigin("not a URL")).toThrow("Invalid server URL");
    expect(extractFirstUrl("no URL here")).toBeUndefined();
  });
});
