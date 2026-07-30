import type { IncomingMessage } from "../../src/domain/types";

type MessageOverrides = Omit<Partial<IncomingMessage>, "source"> & {
  source?: Partial<IncomingMessage["source"]>;
};

export function message(overrides: MessageOverrides = {}): IncomingMessage {
  const base: IncomingMessage = {
    schemaVersion: 1,
    key: "server/topic/message",
    source: {
      connectionId: "primary",
      serverOrigin: "https://ntfy.example",
      topic: "test-topic",
      messageId: "AbCd123456",
    },
    publishedAtMs: Date.UTC(2026, 6, 29, 4, 5, 6, 7),
    receivedAtMs: Date.UTC(2026, 6, 29, 4, 5, 7, 8),
    title: "",
    body: "hello",
    priority: 3,
    tags: [],
    unknownFields: [],
  };
  return {
    ...base,
    ...overrides,
    source: { ...base.source, ...overrides.source },
  };
}
