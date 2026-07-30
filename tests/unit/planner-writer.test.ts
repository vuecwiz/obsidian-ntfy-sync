import { planEffect } from "../../src/effects/planner";
import { VaultWriter, insertBlock } from "../../src/effects/vault-writer";
import {
  DEFAULT_RULES,
  DEFAULT_TEMPLATES,
  createDefaultSettings,
} from "../../src/settings/defaults";
import { message } from "../helpers/message";
import { MemoryVault } from "../helpers/memory-vault";

describe("effect planner and Vault writer", () => {
  it("forces a stable marker and generic inbox path", () => {
    const settings = createDefaultSettings();
    const rule = DEFAULT_RULES.rules.at(-1)!;
    const plan = planEffect(
      message({ body: "plain" }),
      rule,
      DEFAULT_TEMPLATES,
      settings.processing,
    );
    expect(plan.notePath).toBe("Ntfy Sync/Inbox.md");
    expect(plan.marker).toMatch(/^<!-- ntfy-sync:v1 key=[a-f0-9]{64} rule=/);
    expect(plan.marker).not.toContain("test-topic");
    expect(plan.marker).not.toContain("AbCd123456");
    expect(plan.renderedBlock).toContain(plan.marker);
  });

  it("uses link-only for external attachments", () => {
    const settings = createDefaultSettings();
    const plan = planEffect(
      message({
        attachment: { name: "file.pdf", url: "https://external.example/file.pdf" },
      }),
      DEFAULT_RULES.rules.at(-1)!,
      DEFAULT_TEMPLATES,
      settings.processing,
    );
    expect(plan.attachment?.mode).toBe("link-only");
    expect(plan.renderedBlock).toContain("[Attachment: file.pdf]");
  });

  it("rejects invalid, expired and oversized attachment descriptors", () => {
    const settings = createDefaultSettings();
    const rule = DEFAULT_RULES.rules.at(-1)!;
    expect(() =>
      planEffect(
        message({ attachment: { name: "bad", url: "javascript:alert(1)" } }),
        rule,
        DEFAULT_TEMPLATES,
        settings.processing,
      ),
    ).toThrow("scheme");
    expect(() =>
      planEffect(
        message({
          receivedAtMs: 1000,
          attachment: { name: "old", url: "https://ntfy.example/file", expiresAtMs: 999 },
        }),
        rule,
        DEFAULT_TEMPLATES,
        settings.processing,
      ),
    ).toThrow("expired");
    expect(() =>
      planEffect(
        message({
          attachment: {
            name: "large",
            url: "https://ntfy.example/file",
            size: settings.processing.maxAttachmentBytes + 1,
          },
        }),
        rule,
        DEFAULT_TEMPLATES,
        settings.processing,
      ),
    ).toThrow("configured limit");
  });

  it("escapes untrusted external attachment Markdown", () => {
    const plan = planEffect(
      message({
        attachment: {
          name: "file] [injected",
          url: "https://external.example/file(1).pdf",
        },
      }),
      DEFAULT_RULES.rules.at(-1)!,
      DEFAULT_TEMPLATES,
      createDefaultSettings().processing,
    );
    expect(plan.renderedBlock).toContain("file\\] \\[injected");
    expect(plan.renderedBlock).toContain("file%281%29.pdf");
  });

  it("resolves file variables from the deterministic same-origin target", () => {
    const settings = createDefaultSettings();
    const templates = structuredClone(DEFAULT_TEMPLATES);
    templates.entries.inbox = "{{file:embed}}";
    const plan = planEffect(
      message({
        attachment: {
          name: "file.pdf",
          url: "https://ntfy.example/file/AbCd123456/file.pdf",
        },
      }),
      DEFAULT_RULES.rules.at(-1)!,
      templates,
      settings.processing,
    );
    expect(plan.attachment?.mode).toBe("download");
    expect(plan.renderedBlock).toContain("![[Ntfy Sync/Attachments/");
  });

  it("inserts after a heading without escaping its section", () => {
    const rule = structuredClone(DEFAULT_RULES.rules[0]!);
    rule.action.insertion = "after-heading";
    rule.action.heading = "### Log";
    const plan = planEffect(message(), rule, DEFAULT_TEMPLATES, createDefaultSettings().processing);
    const result = insertBlock("### Log\nold\n\n### Next\nkeep", plan);
    expect(result.indexOf("old")).toBeLessThan(result.indexOf(plan.marker));
    expect(result.indexOf(plan.marker)).toBeLessThan(result.indexOf("### Next"));
  });

  it("is idempotent and serializes concurrent writes to one path", async () => {
    const vault = new MemoryVault();
    const writer = new VaultWriter(vault);
    const first = planEffect(
      message({ key: "one", source: { messageId: "one" } }),
      DEFAULT_RULES.rules.at(-1)!,
      DEFAULT_TEMPLATES,
      createDefaultSettings().processing,
    );
    const second = planEffect(
      message({ key: "two", source: { messageId: "two" } }),
      DEFAULT_RULES.rules.at(-1)!,
      DEFAULT_TEMPLATES,
      createDefaultSettings().processing,
    );
    await Promise.all([writer.execute(first), writer.execute(second)]);
    const retry = await writer.execute(first);
    const content = vault.text.get(first.notePath) ?? "";
    expect(retry.alreadyApplied).toBe(true);
    expect(content.match(/ntfy-sync:v1/g)).toHaveLength(2);
  });

  it("covers append, prepend and missing-heading insertion contracts", () => {
    const base = planEffect(
      message(),
      DEFAULT_RULES.rules.at(-1)!,
      DEFAULT_TEMPLATES,
      createDefaultSettings().processing,
    );
    expect(insertBlock("", { ...base, insertion: { mode: "append" } })).toBe(
      `${base.renderedBlock}\n`,
    );
    expect(insertBlock("old", { ...base, insertion: { mode: "prepend" } })).toBe(
      `${base.renderedBlock}\n\nold`,
    );
    expect(insertBlock("", { ...base, insertion: { mode: "prepend" } })).toBe(
      `${base.renderedBlock}\n`,
    );
    expect(
      insertBlock("existing", {
        ...base,
        insertion: { mode: "after-heading", heading: "### Created" },
      }),
    ).toContain("existing\n\n### Created\n\n");
    expect(() =>
      insertBlock("existing", { ...base, insertion: { mode: "after-heading" } }),
    ).toThrow("Missing insertion heading");
  });

  it("inspects marker presence without mutating the Vault", async () => {
    const vault = new MemoryVault();
    const writer = new VaultWriter(vault);
    const plan = planEffect(
      message(),
      DEFAULT_RULES.rules.at(-1)!,
      DEFAULT_TEMPLATES,
      createDefaultSettings().processing,
    );
    expect(await writer.inspect(plan)).toBe(false);
    vault.text.set(plan.notePath, plan.renderedBlock);
    expect(await writer.inspect(plan)).toBe(true);
  });
});
