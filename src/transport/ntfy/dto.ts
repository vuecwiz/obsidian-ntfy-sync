export interface NtfyMessageDto {
  id?: unknown;
  time?: unknown;
  expires?: unknown;
  event?: unknown;
  topic?: unknown;
  sequence_id?: unknown;
  message?: unknown;
  title?: unknown;
  tags?: unknown;
  priority?: unknown;
  click?: unknown;
  actions?: unknown;
  attachment?: unknown;
  content_type?: unknown;
  [futureField: string]: unknown;
}

export type ParsedNtfyEvent =
  | {
      kind: "open" | "keepalive" | "message_delete" | "message_clear" | "poll_request";
      dto: NtfyMessageDto;
    }
  | { kind: "message"; dto: NtfyMessageDto }
  | { kind: "unknown"; event: string; dto: NtfyMessageDto };

export const KNOWN_FIELDS = new Set([
  "id",
  "time",
  "expires",
  "event",
  "topic",
  "sequence_id",
  "message",
  "title",
  "tags",
  "priority",
  "click",
  "actions",
  "attachment",
  "content_type",
]);
