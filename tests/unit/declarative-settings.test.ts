import type { App, SettingDefinitionItem } from "obsidian";
import type NtfySyncPlugin from "../../src/main";
import type { ConnectionConfigV1 } from "../../src/domain/types";
import { createI18n } from "../../src/i18n";
import { createDefaultSettings } from "../../src/settings/defaults";
import { NtfySyncSettingTab } from "../../src/settings/tab";

function collectNames(items: SettingDefinitionItem[]): string[] {
  return items.flatMap((item) => {
    if (!("name" in item)) {
      return collectNames(item.items ?? []);
    }
    if ("type" in item && item.type === "page") {
      return [item.name, ...collectNames(item.items ?? [])];
    }
    return [item.name];
  });
}

function createTab() {
  const settings = createDefaultSettings();
  const i18n = createI18n("en", "en");
  const plugin = {
    settings,
    i18n,
    saveSettings: vi.fn(),
    setUiLanguage: vi.fn(),
  } as unknown as NtfySyncPlugin;
  const tab = new NtfySyncSettingTab({} as App, plugin);
  return { i18n, plugin, settings, tab };
}

describe("declarative settings", () => {
  it("indexes every top-level setting and the default rule without I/O", () => {
    const { i18n, settings, tab } = createTab();
    const definitions = tab.getSettingDefinitions();
    const names = collectNames(definitions);

    expect(settings.connections).toHaveLength(0);
    expect(names).toEqual(
      expect.arrayContaining([
        i18n.t("settings.enableReceiving"),
        i18n.t("settings.serverUrl"),
        i18n.t("settings.topics"),
        i18n.t("settings.mode"),
        i18n.t("settings.authentication"),
        i18n.t("settings.allowLoopback"),
        i18n.t("settings.publishResults"),
        i18n.t("settings.rules"),
        "Inbox",
        i18n.t("language.name"),
        i18n.t("settings.validateReconnect"),
      ]),
    );
    expect(
      definitions.every(
        (item) =>
          ("type" in item && (item.type === "group" || item.type === "list")) || "render" in item,
      ),
    ).toBe(true);
  });

  it("indexes conditional credential and result settings without exposing values", () => {
    const { i18n, settings, tab } = createTab();
    const connection: ConnectionConfigV1 = {
      id: "primary",
      name: "Primary ntfy",
      baseUrl: "https://ntfy.sh",
      topics: ["example-topic"],
      readAuth: { kind: "none" },
      mode: "auto",
      pollIntervalSeconds: 30,
      allowInsecureHttp: false,
      initialReplay: { kind: "latest" },
      reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
    };
    settings.connections.push(connection);
    connection.readAuth = {
      kind: "basic",
      username: "private-user-value",
      password: "private-password-value",
    };
    connection.result = {
      topic: "private-topic-value",
      writeAuth: { kind: "bearer", token: "private-token-value" },
      privacy: "minimal",
      cache: true,
    };

    const definitions = tab.getSettingDefinitions();
    const names = collectNames(definitions);
    expect(names).toEqual(
      expect.arrayContaining([
        i18n.t("settings.username"),
        i18n.t("settings.password"),
        i18n.t("settings.resultTopic"),
        i18n.t("settings.resultPrivacy"),
        i18n.t("settings.cacheResults"),
        i18n.t("settings.resultAuthentication"),
        i18n.t("settings.resultToken"),
      ]),
    );

    const searchableMetadata = JSON.stringify(definitions);
    expect(searchableMetadata).not.toContain("private-user-value");
    expect(searchableMetadata).not.toContain("private-password-value");
    expect(searchableMetadata).not.toContain("private-topic-value");
    expect(searchableMetadata).not.toContain("private-token-value");
  });
});
