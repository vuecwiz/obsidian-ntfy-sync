import { DurableInboxService } from "../../src/inbox/durable-inbox";
import { decodeState, emptyState, encodeState, JsonStateStore } from "../../src/state/store";
import { stateStoreFixture } from "../helpers/memory-state-adapter";
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
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
    await store.load();
    const inbox = new DurableInboxService(store);
    expect(await inbox.accept(message(), 1)).toBe("persisted");
    expect(await inbox.accept(message(), 2)).toBe("duplicate");
    const disk = decodeState(await adapter.read(store.primaryPath));
    expect(Object.keys(disk.records)).toEqual(["server/topic/message"]);
    expect(disk.telemetry.duplicates).toBe(1);
  });

  it("recovers a valid backup and isolates a corrupt primary", async () => {
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
    await store.load();
    const inbox = new DurableInboxService(store);
    await inbox.accept(message(), 1);
    await inbox.accept(message({ key: "second" }), 2);
    await adapter.write(store.primaryPath, "{partial");
    const recovered = new JsonStateStore(adapter, directory);
    const state = await recovered.load();
    expect(Object.keys(state.records)).toContain("server/topic/message");
  });

  it("preserves the primary and backup when adapter replacement is interrupted", async () => {
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
    await store.load();
    const inbox = new DurableInboxService(store);
    await inbox.accept(message(), 1);
    adapter.beforeWrite = (path) => {
      if (path === store.primaryPath) throw new Error("injected primary write failure");
    };
    await expect(inbox.accept(message({ key: "interrupted" }), 2)).rejects.toThrow(
      "injected primary write failure",
    );
    expect(await adapter.exists(store.primaryPath)).toBe(true);
    expect(await adapter.exists(store.backupPath)).toBe(true);
    expect([...adapter.files.keys()].some((path) => path.includes(".tmp-"))).toBe(false);

    adapter.beforeWrite = undefined;
    const recovered = new JsonStateStore(adapter, directory);
    const state = await recovered.load();
    expect(Object.keys(state.records)).toEqual(["server/topic/message"]);
    expect(await adapter.exists(recovered.primaryPath)).toBe(true);
  });

  it("recovers a valid backup when a primary is unexpectedly missing", async () => {
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
    await store.load();
    const inbox = new DurableInboxService(store);
    await inbox.accept(message(), 1);
    await adapter.remove(store.primaryPath);

    const recovered = new JsonStateStore(adapter, directory);
    const state = await recovered.load();
    expect(Object.keys(state.records)).toEqual([]);
    expect(await adapter.exists(recovered.primaryPath)).toBe(true);
  });

  it("never prunes pending or dead-letter records", async () => {
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
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
  });

  it("handles retries, watermarks, ignored events, outbox and completed pruning", async () => {
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
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
  });

  it("isolates primary corruption and blocks when backup is also corrupt", async () => {
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
    await store.load();
    const inbox = new DurableInboxService(store);
    await inbox.accept(message(), 1);
    await adapter.write(store.primaryPath, "{bad-primary");
    await adapter.write(store.backupPath, "{bad-backup");
    await expect(new JsonStateStore(adapter, directory).load()).rejects.toThrow("valid JSON");
    expect([...adapter.files.keys()].some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("blocks a corrupt primary when no backup exists", async () => {
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
    await store.load();
    await adapter.write(store.primaryPath, "{bad");
    await adapter.remove(store.backupPath);
    await expect(new JsonStateStore(adapter, directory).load()).rejects.toThrow("valid JSON");
  });

  it("covers missing records and absent outbox targets", async () => {
    const { adapter, directory } = stateStoreFixture();
    const store = new JsonStateStore(adapter, directory);
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
  });
});
