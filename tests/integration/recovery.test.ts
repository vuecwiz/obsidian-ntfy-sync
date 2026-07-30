import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageProcessor } from "../../src/app/processor";
import { ResultOutboxService } from "../../src/app/result-outbox";
import { AttachmentService } from "../../src/effects/attachment";
import { planEffect } from "../../src/effects/planner";
import { VaultWriter } from "../../src/effects/vault-writer";
import { DurableInboxService } from "../../src/inbox/durable-inbox";
import {
  createDefaultSettings,
  DEFAULT_RULES,
  DEFAULT_TEMPLATES,
} from "../../src/settings/defaults";
import { JsonStateStore } from "../../src/state/store";
import { MemoryVault } from "../helpers/memory-vault";
import { message } from "../helpers/message";

describe("crash-window recovery", () => {
  it("converges accepted/planned/applying/committed to one marker each", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-recovery-"));
    try {
      const settings = createDefaultSettings();
      settings.connections = [
        {
          id: "primary",
          name: "test",
          baseUrl: "https://ntfy.example",
          topics: ["test-topic"],
          readAuth: { kind: "none" },
          mode: "poll",
          pollIntervalSeconds: 30,
          allowInsecureHttp: false,
          initialReplay: { kind: "latest" },
          reconnect: { minMs: 1000, maxMs: 60000, jitterRatio: 1 },
        },
      ];
      const store = new JsonStateStore(directory);
      await store.load();
      const inbox = new DurableInboxService(store);
      const vault = new MemoryVault();
      const rule = DEFAULT_RULES.rules.at(-1)!;
      const records = ["accepted", "planned", "applying", "committed"].map((status, index) => {
        const value = message({
          key: `key-${status}`,
          body: status,
          source: { messageId: `id-${index}` },
        });
        return {
          status,
          value,
          plan: planEffect(value, rule, DEFAULT_TEMPLATES, settings.processing),
        };
      });
      for (const record of records) await inbox.accept(record.value);
      await inbox.savePlan(records[1]!.value.key, records[1]!.plan);
      await inbox.savePlan(records[2]!.value.key, records[2]!.plan);
      await inbox.markApplying(records[2]!.value.key);
      await inbox.savePlan(records[3]!.value.key, records[3]!.plan);
      await inbox.markApplying(records[3]!.value.key);
      await inbox.markCommitted(records[3]!.value.key, {
        notePath: records[3]!.plan.notePath,
        markerFound: true,
        alreadyApplied: false,
        committedAtMs: Date.now(),
      });
      vault.text.set(
        records[0]!.plan.notePath,
        `${records[2]!.plan.renderedBlock}\n\n${records[3]!.plan.renderedBlock}\n`,
      );
      const outbox = new ResultOutboxService(inbox, () => settings.connections);
      const processor = new MessageProcessor(
        () => settings,
        inbox,
        new VaultWriter(vault),
        new AttachmentService(vault),
        outbox,
      );
      await processor.processAvailableNow();
      await processor.processAvailableNow();
      await processor.processAvailableNow();
      for (const record of records) {
        expect(inbox.get(record.value.key)?.status).toBe("complete");
      }
      const content = vault.text.get(records[0]!.plan.notePath) ?? "";
      expect(content.match(/ntfy-sync:v1/g)).toHaveLength(4);
      for (const record of records) {
        expect(content.split(record.plan.marker)).toHaveLength(2);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a committed effect with a pending result outbox without rewriting the note", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ntfy-result-recovery-"));
    const originalFetch = globalThis.fetch;
    try {
      const settings = createDefaultSettings();
      settings.connections = [
        {
          id: "primary",
          name: "test",
          baseUrl: "https://ntfy.example",
          topics: ["test-topic"],
          readAuth: { kind: "none" },
          result: {
            topic: "result-topic",
            writeAuth: { kind: "bearer", token: "fixture-token" },
            privacy: "minimal",
            cache: true,
          },
          mode: "poll",
          pollIntervalSeconds: 30,
          allowInsecureHttp: false,
          initialReplay: { kind: "latest" },
          reconnect: { minMs: 1000, maxMs: 60000, jitterRatio: 1 },
        },
      ];
      const firstStore = new JsonStateStore(directory);
      await firstStore.load();
      const firstInbox = new DurableInboxService(firstStore);
      const value = message();
      const plan = planEffect(
        value,
        DEFAULT_RULES.rules.at(-1)!,
        DEFAULT_TEMPLATES,
        settings.processing,
      );
      const vault = new MemoryVault();
      await firstInbox.accept(value);
      await firstInbox.savePlan(value.key, plan);
      await firstInbox.markApplying(value.key);
      const receipt = await new VaultWriter(vault).execute(plan);
      await firstInbox.markCommitted(value.key, receipt);
      await firstInbox.enqueueOutbox({
        sourceKey: value.key,
        connectionId: "primary",
        payload: {
          schema: "obsidian.ntfy-sync.result.v1",
          correlation: { topic: value.source.topic, messageId: value.source.messageId },
          outcome: "succeeded",
          processedAt: new Date(0).toISOString(),
          targetCount: 1,
        },
        attempts: 0,
        nextAttemptAtMs: 0,
        status: "pending",
      });

      const published: Array<{ authorization: string | null; body: string }> = [];
      globalThis.fetch = vi.fn(async (_input, init) => {
        const headers = new Headers(init?.headers);
        published.push({
          authorization: headers.get("authorization"),
          body: String(init?.body ?? ""),
        });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const recoveredStore = new JsonStateStore(directory);
      await recoveredStore.load();
      const recoveredInbox = new DurableInboxService(recoveredStore);
      const processor = new MessageProcessor(
        () => settings,
        recoveredInbox,
        new VaultWriter(vault),
        new AttachmentService(vault),
        new ResultOutboxService(recoveredInbox, () => settings.connections),
      );
      await processor.processAvailableNow();

      expect(recoveredInbox.get(value.key)?.status).toBe("complete");
      expect(recoveredStore.snapshot().outbox[value.key]?.status).toBe("sent");
      expect(published).toHaveLength(1);
      expect(published[0]?.authorization).toBe("Bearer fixture-token");
      expect(JSON.parse(published[0]!.body)).toMatchObject({
        topic: "result-topic",
        cache: "yes",
      });
      expect((vault.text.get(plan.notePath) ?? "").match(/ntfy-sync:v1/g)).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
