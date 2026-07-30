import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableInboxService } from "../../src/inbox/durable-inbox";
import { decodeState, emptyState, encodeState, JsonStateStore } from "../../src/state/store";
import { message } from "../helpers/message";

describe("durable state and inbox", () => {
  it("rejects non-object and unsupported state envelopes", () => {
    expect(() => decodeState("null")).toThrow("not an object");
    expect(() => decodeState("[]")).toThrow("not an object");
    expect(() => decodeState('{"schemaVersion":2}')).toThrow("Unsupported");
    const valid = JSON.parse(encodeState(emptyState(1)));
    valid.payload.schemaVersion = 2;
    expect(() => decodeState(JSON.stringify(valid))).toThrow("checksum");
  });

  it("detects checksum corruption", () => {
    const encoded = encodeState(emptyState(1)).replace('"updatedAtMs": 1', '"updatedAtMs": 2');
    expect(() => decodeState(encoded)).toThrow("checksum");
  });

  it("persists before acknowledging and deduplicates source keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-state-"));
    try {
      const store = new JsonStateStore(directory);
      await store.load();
      const inbox = new DurableInboxService(store);
      expect(await inbox.accept(message(), 1)).toBe("persisted");
      expect(await inbox.accept(message(), 2)).toBe("duplicate");
      const disk = decodeState(await readFile(join(directory, "state-v1.json"), "utf8"));
      expect(Object.keys(disk.records)).toEqual(["server/topic/message"]);
      expect(disk.telemetry.duplicates).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a valid backup and isolates a corrupt primary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-state-"));
    try {
      const store = new JsonStateStore(directory);
      await store.load();
      const inbox = new DurableInboxService(store);
      await inbox.accept(message(), 1);
      await inbox.accept(message({ key: "second" }), 2);
      await writeFile(store.primaryPath, "{partial", "utf8");
      const recovered = new JsonStateStore(directory);
      const state = await recovered.load();
      expect(Object.keys(state.records)).toContain("server/topic/message");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never prunes pending or dead-letter records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-state-"));
    try {
      const store = new JsonStateStore(directory);
      await store.load();
      const inbox = new DurableInboxService(store);
      await inbox.accept(message({ key: "pending" }), 1);
      await inbox.accept(message({ key: "dead" }), 1);
      await inbox.markFailure(
        "dead",
        { code: "BAD", message: "bad", retryable: false, atMs: 1 },
        1,
        1,
      );
      expect(await inbox.prune(0, 0, 10)).toBe(0);
      expect(inbox.get("pending")?.status).toBe("accepted");
      expect(inbox.get("dead")?.status).toBe("dead_letter");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("handles retries, watermarks, ignored events, outbox and completed pruning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-state-"));
    try {
      const store = new JsonStateStore(directory);
      await store.load();
      const inbox = new DurableInboxService(store);
      await inbox.accept(message({ key: "ignored" }), 1);
      await inbox.markIgnored("ignored");
      await inbox.accept(message({ key: "retry" }), 1);
      await inbox.markFailure(
        "retry",
        { code: "TEMP", message: "temporary", retryable: true, atMs: 1 },
        3,
        1,
      );
      expect(inbox.claimable(2)).toHaveLength(0);
      expect(inbox.claimable(5_001).map((record) => record.message.key)).toContain("retry");
      await inbox.markFailure(
        "retry",
        { code: "BAD", message: "permanent", retryable: false, atMs: 2 },
        3,
        2,
      );
      expect(await inbox.retryDeadLetters(3)).toBe(1);
      expect(inbox.get("retry")?.errorHistory).toHaveLength(2);

      await inbox.setWatermark("primary", "topic-a", 1000);
      await inbox.setWatermark("primary", "topic-a", 500);
      await inbox.setWatermark("primary", "topic-b", 800);
      expect(inbox.watermark("primary", ["topic-a", "topic-b"])).toBe(800);
      expect(inbox.watermark("missing", ["topic"])).toBeUndefined();
      await inbox.countIgnoredEvent("keepalive");
      await inbox.countIgnoredEvent("keepalive");

      await inbox.enqueueOutbox({
        sourceKey: "ignored",
        connectionId: "primary",
        payload: {
          schema: "obsidian.ntfy-sync.result.v1",
          correlation: { topic: "topic", messageId: "id" },
          outcome: "ignored",
          processedAt: new Date(0).toISOString(),
          targetCount: 0,
        },
        attempts: 0,
        nextAttemptAtMs: 0,
        status: "pending",
      });
      expect(inbox.pendingOutbox(1)).toHaveLength(1);
      await inbox.updateOutbox("ignored", { status: "sent" });
      expect(inbox.pendingOutbox(1)).toHaveLength(0);
      expect(await inbox.prune(0, 0, 10)).toBe(1);
      expect(inbox.get("ignored")).toBeUndefined();
      expect(store.snapshot().telemetry.ignoredEvents.keepalive).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("isolates primary corruption and blocks when backup is also corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-state-"));
    try {
      const store = new JsonStateStore(directory);
      await store.load();
      const inbox = new DurableInboxService(store);
      await inbox.accept(message(), 1);
      await writeFile(store.primaryPath, "{bad-primary", "utf8");
      await writeFile(store.backupPath, "{bad-backup", "utf8");
      await expect(new JsonStateStore(directory).load()).rejects.toThrow("valid JSON");
      expect((await readdir(directory)).some((name) => name.includes(".corrupt-"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks a corrupt primary when no backup exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-state-"));
    try {
      const store = new JsonStateStore(directory);
      await store.load();
      await writeFile(store.primaryPath, "{bad", "utf8");
      await rm(store.backupPath, { force: true });
      await expect(new JsonStateStore(directory).load()).rejects.toThrow("valid JSON");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("covers missing records and absent outbox targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-state-"));
    try {
      const store = new JsonStateStore(directory);
      await store.load();
      const inbox = new DurableInboxService(store);
      await expect(inbox.markIgnored("missing")).rejects.toThrow("Missing inbox record");
      await inbox.updateOutbox("missing", { status: "failed" });
      await inbox.enqueueOutbox({
        sourceKey: "orphan",
        connectionId: "primary",
        payload: {
          schema: "obsidian.ntfy-sync.result.v1",
          correlation: { topic: "topic", messageId: "id" },
          outcome: "failed",
          processedAt: new Date(0).toISOString(),
          targetCount: 0,
        },
        attempts: 0,
        nextAttemptAtMs: 0,
        status: "pending",
      });
      await inbox.updateOutbox("orphan", { status: "failed" });
      expect(store.snapshot().outbox.orphan?.status).toBe("failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
