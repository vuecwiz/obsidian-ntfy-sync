import { DEFAULT_RULES, DEFAULT_TEMPLATES } from "../../src/settings/defaults";
import { matchRule, validateRuleSet } from "../../src/rules/engine";
import { evaluateCondition } from "../../src/rules/engine";
import { message } from "../helpers/message";

const ROUTING_RULES = {
  schemaVersion: 1 as const,
  matchMode: "first" as const,
  rules: [
    {
      id: "example-host",
      revision: 1,
      name: "Example host",
      enabled: true,
      when: {
        all: [
          {
            field: "firstUrlHost" as const,
            op: "hostOrSubdomainOf" as const,
            value: "alpha.example",
          },
        ],
      },
      action: {
        notePathTemplate: "Test/Example.md",
        contentTemplateId: "inbox",
        insertion: "after-heading" as const,
        heading: "### Log",
      },
    },
    {
      id: "web",
      revision: 1,
      name: "Web",
      enabled: true,
      when: { all: [{ field: "hasHttpUrl" as const, op: "equals" as const, value: true }] },
      action: {
        notePathTemplate: "Test/Web.md",
        contentTemplateId: "inbox",
        insertion: "append" as const,
      },
    },
    structuredClone(DEFAULT_RULES.rules[0]!),
  ],
};

describe("rule engine", () => {
  it.each([
    ["https://alpha.example/page", "example-host"],
    ["https://sub.alpha.example/path", "example-host"],
    ["https://example.com/page", "web"],
    ["plain text", "inbox"],
  ])("routes %s to %s", (body, ruleId) => {
    const firstUrl = body.startsWith("http") ? new URL(body) : undefined;
    const result = matchRule(
      message({
        body,
        firstUrl: firstUrl
          ? {
              raw: body,
              protocol: firstUrl.protocol as "https:",
              hostname: firstUrl.hostname,
            }
          : undefined,
      }),
      ROUTING_RULES,
    );
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.rule.id).toBe(ruleId);
  });

  it("does not match hostile lookalike hosts", () => {
    const result = matchRule(
      message({
        body: "https://evilalpha.example/repo",
        firstUrl: {
          raw: "https://evilalpha.example/repo",
          protocol: "https:",
          hostname: "evilalpha.example",
        },
      }),
      ROUTING_RULES,
    );
    expect(result.kind === "matched" && result.rule.id).toBe("web");
  });

  it("validates duplicate IDs, missing templates and headings", () => {
    const invalid = structuredClone(ROUTING_RULES);
    invalid.rules[1]!.id = invalid.rules[0]!.id;
    invalid.rules[0]!.action.contentTemplateId = "missing";
    delete invalid.rules[0]!.action.heading;
    const issues = validateRuleSet(invalid, new Set(["inbox"]));
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["DUPLICATE", "TEMPLATE_MISSING", "HEADING_REQUIRED"]),
    );
  });

  it("rejects an empty string condition instead of silently matching every message", () => {
    const invalid = structuredClone(ROUTING_RULES);
    invalid.rules[0]!.when.all[0]!.value = "";

    expect(
      validateRuleSet(invalid, new Set(Object.keys(DEFAULT_TEMPLATES.entries))),
    ).toContainEqual(
      expect.objectContaining({
        path: "rules[0].when.all[0].value",
        code: "CONDITION_VALUE",
      }),
    );
  });

  it("evaluates every structured operator", () => {
    const value = message({
      title: "prefix title",
      body: "body contains value",
      priority: 4,
      tags: ["tag-one"],
      firstUrl: { raw: "https://sub.example.com", protocol: "https:", hostname: "sub.example.com" },
      attachment: {
        name: "file.pdf",
        url: "https://ntfy.example/file",
        type: "application/pdf",
      },
    });
    expect(evaluateCondition(value, { field: "topic", op: "equals", value: "test-topic" })).toBe(
      true,
    );
    expect(evaluateCondition(value, { field: "topic", op: "contains", value: "topic" })).toBe(true);
    expect(evaluateCondition(value, { field: "topic", op: "startsWith", value: "test" })).toBe(
      true,
    );
    expect(evaluateCondition(value, { field: "title", op: "equals", value: "prefix title" })).toBe(
      true,
    );
    expect(evaluateCondition(value, { field: "title", op: "contains", value: "fix ti" })).toBe(
      true,
    );
    expect(evaluateCondition(value, { field: "title", op: "startsWith", value: "prefix" })).toBe(
      true,
    );
    expect(
      evaluateCondition(value, { field: "body", op: "equals", value: "body contains value" }),
    ).toBe(true);
    expect(evaluateCondition(value, { field: "body", op: "contains", value: "contains" })).toBe(
      true,
    );
    expect(evaluateCondition(value, { field: "body", op: "startsWith", value: "body" })).toBe(true);
    expect(evaluateCondition(value, { field: "tag", op: "contains", value: "tag-one" })).toBe(true);
    expect(evaluateCondition(value, { field: "priority", op: "equals", value: 4 })).toBe(true);
    expect(evaluateCondition(value, { field: "priority", op: "gte", value: 3 })).toBe(true);
    expect(evaluateCondition(value, { field: "hasAttachment", op: "equals", value: true })).toBe(
      true,
    );
    expect(evaluateCondition(value, { field: "hasHttpUrl", op: "equals", value: true })).toBe(true);
    expect(
      evaluateCondition(value, {
        field: "attachmentMime",
        op: "equals",
        value: "application/pdf",
      }),
    ).toBe(true);
    expect(
      evaluateCondition(value, {
        field: "attachmentMime",
        op: "startsWith",
        value: "application/",
      }),
    ).toBe(true);
    expect(
      evaluateCondition(value, {
        field: "firstUrlHost",
        op: "hostEquals",
        value: "sub.example.com",
      }),
    ).toBe(true);
    expect(
      evaluateCondition(value, {
        field: "firstUrlHost",
        op: "hostOrSubdomainOf",
        value: "example.com",
      }),
    ).toBe(true);
    expect(
      evaluateCondition(message(), {
        field: "firstUrlHost",
        op: "hostEquals",
        value: "example.com",
      }),
    ).toBe(false);
  });

  it("preserves documented case, tag, boolean, MIME and priority boundaries", () => {
    const value = message({
      title: "Case Sensitive",
      body: "Body",
      priority: 3,
      tags: ["very-urgent"],
    });

    expect(evaluateCondition(value, { field: "title", op: "contains", value: "case" })).toBe(false);
    expect(evaluateCondition(value, { field: "tag", op: "contains", value: "urgent" })).toBe(false);
    expect(evaluateCondition(value, { field: "priority", op: "gte", value: 4 })).toBe(false);
    expect(evaluateCondition(value, { field: "hasAttachment", op: "equals", value: false })).toBe(
      true,
    );
    expect(evaluateCondition(value, { field: "hasHttpUrl", op: "equals", value: false })).toBe(
      true,
    );
    expect(
      evaluateCondition(value, { field: "attachmentMime", op: "startsWith", value: "image/" }),
    ).toBe(false);
  });

  it("reports every rule schema validation class", () => {
    const invalid = structuredClone(DEFAULT_RULES);
    invalid.schemaVersion = 2 as 1;
    invalid.matchMode = "all" as "first";
    invalid.rules[0]!.id = "bad id!";
    invalid.rules[0]!.revision = 0;
    invalid.rules[0]!.action.notePathTemplate = "note.txt";
    const codes = validateRuleSet(invalid).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(["SCHEMA", "MATCH_MODE", "ID", "REVISION", "NOTE_EXTENSION"]),
    );
  });

  it("returns none when no enabled rule matches", () => {
    const rules = structuredClone(DEFAULT_RULES);
    rules.rules.forEach((rule) => (rule.enabled = false));
    expect(matchRule(message(), rules)).toEqual({ kind: "none" });
  });

  it("rejects malformed condition and action shapes", () => {
    const invalid = structuredClone(DEFAULT_RULES) as unknown as {
      schemaVersion: 1;
      matchMode: "first";
      rules: unknown[];
    };
    invalid.rules = [
      {
        id: "bad",
        revision: 1,
        name: "Bad",
        enabled: true,
        when: { all: [{ field: "priority", op: "contains", value: "high" }] },
        action: null,
      },
    ];
    expect(validateRuleSet(invalid).map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["CONDITION", "TYPE"]),
    );
    expect(validateRuleSet(null).map((entry) => entry.code)).toContain("TYPE");
  });
});
