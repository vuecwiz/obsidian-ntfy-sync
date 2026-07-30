import { DEFAULT_RULES } from "../../src/settings/defaults";
import {
  createBlankRule,
  createCondition,
  MIME_FAMILY_PRESETS,
  MIME_TYPE_PRESETS,
  mimeTypePresets,
  moveRule,
  operatorsForField,
  removeRule,
  saveRuleDraft,
  summarizeCondition,
  summarizeRule,
} from "../../src/settings/rule-editor";

describe("message distribution rule editor model", () => {
  it("creates a valid-looking unique draft with the inbox template", () => {
    const draft = createBlankRule(["rule", "rule-2"], ["raw", "inbox"]);

    expect(draft).toMatchObject({
      id: "rule-3",
      revision: 1,
      name: "New rule",
      enabled: true,
      when: { all: [] },
      action: {
        notePathTemplate: "Ntfy Sync/Inbox.md",
        contentTemplateId: "inbox",
        insertion: "append",
      },
    });
  });

  it("falls back to the first configured template", () => {
    expect(createBlankRule([], ["custom"]).action.contentTemplateId).toBe("custom");
    expect(createBlankRule([], []).action.contentTemplateId).toBe("");
  });

  it("creates type-safe defaults and matching operators for every field kind", () => {
    expect(createCondition("priority")).toEqual({ field: "priority", op: "equals", value: 3 });
    expect(createCondition("hasAttachment")).toEqual({
      field: "hasAttachment",
      op: "equals",
      value: true,
    });
    expect(createCondition("firstUrlHost")).toEqual({
      field: "firstUrlHost",
      op: "hostOrSubdomainOf",
      value: "",
    });
    expect(operatorsForField("body")).toEqual(["equals", "contains", "startsWith"]);
    expect(operatorsForField("tag")).toEqual(["contains"]);
    expect(operatorsForField("priority")).toEqual(["equals", "gte"]);
    expect(operatorsForField("hasHttpUrl")).toEqual(["equals"]);
    expect(operatorsForField("attachmentMime")).toEqual(["equals", "startsWith"]);
    expect(operatorsForField("firstUrlHost")).toEqual(["hostEquals", "hostOrSubdomainOf"]);
  });

  it("offers searchable MIME presets without restricting custom values", () => {
    const exactValues = mimeTypePresets("equals").map((preset) => preset.value);
    expect(exactValues).toEqual(
      expect.arrayContaining([
        "image/jpeg",
        "image/png",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "application/json",
        "audio/mpeg",
        "video/mp4",
      ]),
    );
    expect(new Set(exactValues).size).toBe(MIME_TYPE_PRESETS.length);
    expect(exactValues).not.toContain("image/");

    const prefixValues = mimeTypePresets("startsWith").map((preset) => preset.value);
    expect(prefixValues.slice(0, MIME_FAMILY_PRESETS.length)).toEqual(
      MIME_FAMILY_PRESETS.map((preset) => preset.value),
    );
    expect(prefixValues).toContain("image/png");
    expect(mimeTypePresets("equals", "markdown").map((preset) => preset.value)).toEqual([
      "text/markdown",
    ]);
    expect(mimeTypePresets("startsWith", "ANY IMAGE").map((preset) => preset.value)).toEqual([
      "image/",
    ]);
    expect(mimeTypePresets("equals", "custom/vendor-type")).toEqual([]);
  });

  it("summarizes all-message, disabled and conditional rules without changing storage", () => {
    const all = structuredClone(DEFAULT_RULES.rules.at(-1)!);
    expect(summarizeRule(all)).toEqual({
      name: "Inbox",
      notePath: "Ntfy Sync/Inbox.md",
      description: "All messages",
    });

    const conditional = structuredClone(DEFAULT_RULES.rules[0]!);
    conditional.when.all = [
      { field: "firstUrlHost", op: "hostOrSubdomainOf", value: "example.com" },
    ];
    conditional.enabled = false;
    expect(summarizeRule(conditional).description).toContain(
      "Disabled · First URL host is or is a subdomain of “example.com”",
    );
    expect(summarizeCondition({ field: "hasHttpUrl", op: "equals", value: true })).toBe(
      "Has HTTP URL: yes",
    );
    expect(summarizeCondition({ field: "tag", op: "contains", value: "urgent" })).toBe(
      "Has tag is “urgent”",
    );
    expect(DEFAULT_RULES.rules[0]!.enabled).toBe(true);
  });

  it("moves rules without mutating input and ignores out-of-range moves", () => {
    const rules = ["one", "two", "three"].map((id) => ({
      ...structuredClone(DEFAULT_RULES.rules[0]!),
      id,
    }));
    const originalIds = rules.map((rule) => rule.id);

    expect(moveRule(rules, 2, 0).map((rule) => rule.id)).toEqual([
      originalIds[2],
      originalIds[0],
      originalIds[1],
    ]);
    expect(moveRule(rules, 0, -1).map((rule) => rule.id)).toEqual(originalIds);
    expect(moveRule(rules, 3, 0).map((rule) => rule.id)).toEqual(originalIds);
    expect(moveRule(rules, 1, 1).map((rule) => rule.id)).toEqual(originalIds);
    expect(rules.map((rule) => rule.id)).toEqual(originalIds);
  });

  it("adds, edits and removes stored rules with deterministic revision changes", () => {
    const original = ["one", "two"].map((id) => ({
      ...structuredClone(DEFAULT_RULES.rules[0]!),
      id,
    }));
    const added = createBlankRule(
      original.map((rule) => rule.id),
      ["inbox"],
    );
    added.revision = 99;

    const afterAdd = saveRuleDraft(original, added);
    expect(afterAdd).toHaveLength(3);
    expect(afterAdd[2]).toMatchObject({ id: "rule", revision: 1 });

    const unchanged = saveRuleDraft(original, structuredClone(original[0]!), 0);
    expect(unchanged[0]!.revision).toBe(original[0]!.revision);

    const edited = structuredClone(original[0]!);
    edited.name = "Renamed";
    const afterEdit = saveRuleDraft(original, edited, 0);
    expect(afterEdit[0]).toMatchObject({ name: "Renamed", revision: original[0]!.revision + 1 });
    expect(original[0]!.name).not.toBe("Renamed");

    expect(removeRule(afterEdit, 0).map((rule) => rule.id)).toEqual([original[1]!.id]);
    expect(removeRule([original[0]!], 0)).toEqual([]);
    expect(moveRule([original[0]!], 0, 0)).toHaveLength(1);
    expect(removeRule(original, -1)).toHaveLength(original.length);
    expect(removeRule(original, original.length)).toHaveLength(original.length);
  });
});
