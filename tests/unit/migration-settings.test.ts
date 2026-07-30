import { createDefaultSettings } from "../../src/settings/defaults";
import { migrateSettings } from "../../src/settings/migrate";
import { validateSettings } from "../../src/settings/validate";

describe("settings migration and validation", () => {
  it("migrates empty and current schema settings safely", () => {
    const defaults = migrateSettings(undefined);
    expect(defaults.schemaVersion).toBe(1);
    expect(defaults.uiLanguage).toBe("auto");
    expect(defaults.rules.rules).toHaveLength(1);
    expect(defaults.rules.rules[0]).toMatchObject({
      id: "inbox",
      name: "Inbox",
      action: { notePathTemplate: "Ntfy Sync/Inbox.md", contentTemplateId: "inbox" },
    });
    expect(Object.keys(defaults.templates.entries)).toEqual(["inbox"]);
    const migrated = migrateSettings({ ...defaults, enabled: true });
    expect(migrated.enabled).toBe(true);
    expect(migrated.processing.overlapSeconds).toBe(120);
  });

  it("migrates and validates the persisted plugin language", () => {
    const defaults = createDefaultSettings();
    const legacy = structuredClone(defaults) as unknown as Record<string, unknown>;
    delete legacy.uiLanguage;
    expect(migrateSettings(legacy).uiLanguage).toBe("auto");
    expect(migrateSettings({ ...defaults, uiLanguage: "zh-CN" }).uiLanguage).toBe("zh-CN");
    expect(migrateSettings({ ...defaults, uiLanguage: "invalid" }).uiLanguage).toBe("auto");

    expect(validateSettings({ ...defaults, uiLanguage: "invalid" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "uiLanguage", code: "LANGUAGE" })]),
    );
  });

  it("validates connection schemes and topics", () => {
    const settings = createDefaultSettings();
    settings.connections.push({
      id: "primary",
      name: "bad",
      baseUrl: "http://external.example",
      topics: [],
      readAuth: { kind: "none" },
      mode: "auto",
      pollIntervalSeconds: 30,
      allowInsecureHttp: true,
      initialReplay: { kind: "latest" },
      reconnect: { minMs: 1000, maxMs: 60000, jitterRatio: 1 },
    });
    expect(validateSettings(settings).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["BASE_URL", "TOPICS"]),
    );
  });

  it("enforces the official ntfy topic character set and length", () => {
    const settings = createDefaultSettings();
    settings.connections.push({
      id: "primary",
      name: "topic validation",
      baseUrl: "https://ntfy.example",
      topics: ["valid_topic-1", "invalid/topic"],
      readAuth: { kind: "none" },
      result: {
        topic: "x".repeat(65),
        writeAuth: { kind: "none" },
        privacy: "minimal",
        cache: true,
      },
      mode: "auto",
      pollIntervalSeconds: 30,
      allowInsecureHttp: false,
      initialReplay: { kind: "latest" },
      reconnect: { minMs: 1000, maxMs: 60000, jitterRatio: 1 },
    });

    expect(validateSettings(settings).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["TOPICS", "RESULT_TOPIC"]),
    );

    settings.connections[0]!.topics = ["A", "b".repeat(64)];
    settings.connections[0]!.result!.topic = "valid_result-2";
    const topicCodes = validateSettings(settings)
      .map((issue) => issue.code)
      .filter((code) => code === "TOPICS" || code === "RESULT_TOPIC");
    expect(topicCodes).toEqual([]);
  });

  it("reports malformed pasted JSON without throwing", () => {
    expect(() =>
      validateSettings({
        schemaVersion: 1,
        enabled: "yes",
        device: null,
        connections: [null],
        rules: { schemaVersion: 1, matchMode: "first" },
        templates: { schemaVersion: 1, entries: { raw: 42 } },
        processing: null,
        diagnostics: null,
      }),
    ).not.toThrow();
    const codes = validateSettings({
      schemaVersion: 1,
      enabled: "yes",
      device: null,
      connections: [null],
      rules: { schemaVersion: 1, matchMode: "first" },
      templates: { schemaVersion: 1, entries: { raw: 42 } },
      processing: null,
      diagnostics: null,
    }).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(["TYPE", "DEVICE"]));
  });

  it("validates duplicate connections and separate result credentials", () => {
    const settings = createDefaultSettings();
    const connection = {
      id: "duplicate",
      name: "duplicate",
      baseUrl: "https://ntfy.example",
      topics: ["input"],
      readAuth: { kind: "basic" as const, username: "user", password: "" },
      result: {
        topic: "input",
        writeAuth: { kind: "bearer" as const, token: "" },
        privacy: "minimal" as const,
        cache: true,
      },
      mode: "stream" as const,
      pollIntervalSeconds: 30,
      allowInsecureHttp: false,
      initialReplay: { kind: "latest" as const },
      reconnect: { minMs: 1000, maxMs: 60000, jitterRatio: 1 },
    };
    settings.connections = [connection, structuredClone(connection)];
    const codes = validateSettings(settings).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(["DUPLICATE", "RESULT_TOPIC", "AUTH"]));
  });
});
