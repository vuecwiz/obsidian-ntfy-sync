import type { NtfyMessageDto, ParsedNtfyEvent } from "./dto";
import { SyncError } from "../../shared/errors";

export function parseNtfyLine(line: string): ParsedNtfyEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new SyncError("PROTOCOL_INVALID", "Malformed ntfy JSON line", false);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncError("PROTOCOL_INVALID", "ntfy event must be an object", false);
  }
  const dto = value as NtfyMessageDto;
  const event = typeof dto.event === "string" ? dto.event : "";
  switch (event) {
    case "open":
    case "keepalive":
    case "message_delete":
    case "message_clear":
    case "poll_request":
      return { kind: event, dto };
    case "message":
      return { kind: "message", dto };
    default:
      return { kind: "unknown", event, dto };
  }
}

export class NdjsonParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";

  push(chunk: Uint8Array): ParsedNtfyEvent[] {
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    } catch {
      throw new SyncError("PROTOCOL_INVALID", "Invalid UTF-8 in ntfy stream", false);
    }
    return this.takeLines(false);
  }

  finish(): ParsedNtfyEvent[] {
    try {
      this.buffer += this.decoder.decode();
    } catch {
      throw new SyncError("PROTOCOL_INVALID", "Invalid final UTF-8 in ntfy stream", false);
    }
    return this.takeLines(true);
  }

  private takeLines(flush: boolean): ParsedNtfyEvent[] {
    const segments = this.buffer.split(/\r?\n/);
    this.buffer = flush ? "" : (segments.pop() ?? "");
    if (flush && this.buffer) segments.push(this.buffer);
    const events: ParsedNtfyEvent[] = [];
    for (const line of segments) {
      const event = parseNtfyLine(line);
      if (event) events.push(event);
    }
    return events;
  }
}
