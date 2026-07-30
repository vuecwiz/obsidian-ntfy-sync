import { readFileSync } from "node:fs";
import { NdjsonParser, parseNtfyLine } from "../../src/transport/ntfy/parser";

describe("NDJSON parser", () => {
  it("parses all v2.26.3 and future events", () => {
    const raw = readFileSync("tests/fixtures/ntfy-v2.26.3/events.ndjson");
    const parser = new NdjsonParser();
    const events = [...parser.push(raw), ...parser.finish()];
    expect(events.map((event) => event.kind)).toEqual([
      "open",
      "keepalive",
      "message",
      "message_delete",
      "message_clear",
      "poll_request",
      "unknown",
    ]);
  });

  it("preserves 1000 messages across arbitrary byte chunk boundaries", () => {
    const lines = Array.from({ length: 1000 }, (_, index) =>
      JSON.stringify({
        event: "message",
        id: String(index).padStart(10, "0"),
        time: 1785297600,
        topic: "随机-topic",
        message: `第 ${index} 条 🚀`,
      }),
    ).join("\n");
    const bytes = new TextEncoder().encode(`${lines}\n`);
    const parser = new NdjsonParser();
    const events = [];
    let offset = 0;
    while (offset < bytes.length) {
      const size = ((offset * 17 + 13) % 97) + 1;
      events.push(...parser.push(bytes.slice(offset, offset + size)));
      offset += size;
    }
    events.push(...parser.finish());
    expect(events).toHaveLength(1000);
    expect(events.every((event) => event.kind === "message")).toBe(true);
  });

  it("supports CRLF and rejects malformed JSON", () => {
    const parser = new NdjsonParser();
    expect(parser.push(new TextEncoder().encode('{"event":"open"}\r\n'))).toHaveLength(1);
    expect(() => parseNtfyLine("{broken")).toThrow("Malformed ntfy JSON line");
  });

  it("rejects invalid UTF-8", () => {
    const parser = new NdjsonParser();
    expect(() => parser.push(Uint8Array.from([0xc3, 0x28]))).toThrow("Invalid UTF-8");
  });
});
