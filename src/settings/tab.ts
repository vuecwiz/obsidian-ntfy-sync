import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type NtfySyncPlugin from "../main";
import type { AuthConfig, ConnectionConfigV1, RuleV1, UiLanguageSetting } from "../domain/types";
import { localizeValidationIssue } from "../i18n";
import { MessageDistributionRuleModal } from "../ui/rule-modal";
import { moveRule, removeRule, saveRuleDraft, summarizeRule } from "./rule-editor";
import { isValidNtfyTopic, validateSettings } from "./validate";

function emptyConnection(): ConnectionConfigV1 {
  return {
    id: "primary",
    name: "Primary ntfy",
    baseUrl: "https://ntfy.sh",
    topics: [],
    readAuth: { kind: "none" },
    mode: "auto",
    pollIntervalSeconds: 30,
    allowInsecureHttp: false,
    initialReplay: { kind: "latest" },
    reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
  };
}

export class NtfySyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: NtfySyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    const i18n = this.plugin.i18n;
    const { t } = i18n;
    containerEl.empty();
    containerEl.addClass("ntfy-sync-settings");
    containerEl.dataset.locale = i18n.locale;
    containerEl.createEl("h2", { text: t("settings.title") });

    new Setting(containerEl)
      .setName(t("settings.enableReceiving"))
      .setDesc(t("settings.enableReceivingDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings(true);
        }),
      );

    const connection = this.plugin.settings.connections[0] ?? emptyConnection();
    if (!this.plugin.settings.connections.length) this.plugin.settings.connections.push(connection);

    containerEl.createEl("h3", { text: t("settings.primaryConnection") });
    new Setting(containerEl)
      .setName(t("settings.serverUrl"))
      .setClass("ntfy-sync-control-14rem")
      .setClass("ntfy-sync-server-url-setting")
      .addText((text) => {
        text.inputEl.dataset.testid = "ntfy-server-url";
        text.setValue(connection.baseUrl).onChange(async (value) => {
          connection.baseUrl = value.trim();
          await this.plugin.saveSettings(false);
        });
      });
    let resultTopicSetting: Setting | undefined;
    const topicsSetting = new Setting(containerEl)
      .setName(t("settings.topics"))
      .setDesc(t("settings.topicsDesc"))
      .setClass("ntfy-sync-control-14rem")
      .setClass("ntfy-sync-topics-setting")
      .addText((text) => {
        text.inputEl.dataset.testid = "ntfy-topics";
        text.setValue(connection.topics.join(", ")).onChange(async (value) => {
          const topics = value.split(",").map((topic) => topic.trim());
          if (!topics.length || topics.some((topic) => !isValidNtfyTopic(topic))) {
            setInlineValidation(
              topicsSetting,
              t("settings.topicInvalid"),
              "ntfy-topics-validation",
            );
            return;
          }
          if (connection.result?.topic && topics.includes(connection.result.topic)) {
            setInlineValidation(
              topicsSetting,
              t("settings.inputResultConflict"),
              "ntfy-topics-validation",
            );
            if (resultTopicSetting) {
              setInlineValidation(
                resultTopicSetting,
                t("settings.resultTopicConflict"),
                "ntfy-result-topic-validation",
              );
            }
            return;
          }
          clearInlineValidation(topicsSetting, t("settings.topicsDesc"));
          connection.topics = topics;
          if (resultTopicSetting && connection.result) {
            refreshResultTopicValidation(
              resultTopicSetting,
              connection.result.topic,
              topics,
              t("settings.topicInvalid"),
              t("settings.resultTopicConflict"),
              t("settings.resultTopicDesc"),
            );
          }
          await this.plugin.saveSettings(false);
        });
      });
    if (!connection.topics.length || connection.topics.some((topic) => !isValidNtfyTopic(topic))) {
      setInlineValidation(topicsSetting, t("settings.topicInvalid"), "ntfy-topics-validation");
    }
    new Setting(containerEl).setName(t("settings.mode")).addDropdown((dropdown) =>
      dropdown
        .addOptions({
          auto: t("settings.modeAuto"),
          stream: t("settings.modeStream"),
          poll: t("settings.modePoll"),
        })
        .setValue(connection.mode)
        .onChange(async (value) => {
          connection.mode = value as ConnectionConfigV1["mode"];
          await this.plugin.saveSettings(true);
        }),
    );
    new Setting(containerEl).setName(t("settings.authentication")).addDropdown((dropdown) => {
      dropdown.selectEl.dataset.testid = "ntfy-read-auth-kind";
      dropdown
        .addOptions({
          none: t("settings.authNone"),
          basic: t("settings.authBasic"),
          bearer: t("settings.authBearer"),
        })
        .setValue(connection.readAuth.kind)
        .onChange(async (kind) => {
          connection.readAuth =
            kind === "basic"
              ? { kind: "basic", username: "", password: "" }
              : kind === "bearer"
                ? { kind: "bearer", token: "" }
                : { kind: "none" };
          await this.plugin.saveSettings(true);
          this.display();
        });
    });
    this.renderAuth(containerEl, connection);
    new Setting(containerEl)
      .setName(t("settings.allowLoopback"))
      .setDesc(t("settings.allowLoopbackDesc"))
      .addToggle((toggle) =>
        toggle.setValue(connection.allowInsecureHttp).onChange(async (value) => {
          connection.allowInsecureHttp = value;
          await this.plugin.saveSettings(true);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.publishResults"))
      .setDesc(t("settings.publishResultsDesc"))
      .setClass("ntfy-sync-control-14rem")
      .setClass("ntfy-sync-publish-result-setting")
      .addToggle((toggle) => {
        toggle.toggleEl.dataset.testid = "ntfy-publish-result";
        toggle.setValue(Boolean(connection.result)).onChange(async (value) => {
          connection.result = value
            ? {
                topic: "",
                writeAuth: { kind: "none" },
                privacy: "minimal",
                cache: true,
              }
            : undefined;
          await this.plugin.saveSettings(true);
          this.display();
        });
      });
    if (connection.result) {
      const result = connection.result;
      const currentResultTopicSetting = new Setting(containerEl)
        .setName(t("settings.resultTopic"))
        .setDesc(t("settings.resultTopicDesc"))
        .setClass("ntfy-sync-control-14rem")
        .setClass("ntfy-sync-result-topic-setting")
        .addText((text) => {
          text.inputEl.dataset.testid = "ntfy-result-topic";
          text.setValue(result.topic).onChange(async (value) => {
            const topic = value.trim();
            if (!isValidNtfyTopic(topic)) {
              setInlineValidation(
                currentResultTopicSetting,
                t("settings.topicInvalid"),
                "ntfy-result-topic-validation",
              );
              return;
            }
            if (connection.topics.includes(topic)) {
              setInlineValidation(
                currentResultTopicSetting,
                t("settings.resultTopicConflict"),
                "ntfy-result-topic-validation",
              );
              return;
            }
            clearInlineValidation(currentResultTopicSetting, t("settings.resultTopicDesc"));
            result.topic = topic;
            await this.plugin.saveSettings(false);
          });
        });
      resultTopicSetting = currentResultTopicSetting;
      refreshResultTopicValidation(
        currentResultTopicSetting,
        result.topic,
        connection.topics,
        t("settings.topicInvalid"),
        t("settings.resultTopicConflict"),
        t("settings.resultTopicDesc"),
      );
      new Setting(containerEl).setName(t("settings.resultPrivacy")).addDropdown((dropdown) =>
        dropdown
          .addOptions({
            minimal: t("settings.privacyMinimal"),
            paths: t("settings.privacyPaths"),
          })
          .setValue(result.privacy)
          .onChange(async (value) => {
            result.privacy = value as "minimal" | "paths";
            await this.plugin.saveSettings(false);
          }),
      );
      new Setting(containerEl).setName(t("settings.cacheResults")).addToggle((toggle) =>
        toggle.setValue(result.cache).onChange(async (value) => {
          result.cache = value;
          await this.plugin.saveSettings(false);
        }),
      );
      new Setting(containerEl)
        .setName(t("settings.resultAuthentication"))
        .addDropdown((dropdown) => {
          dropdown.selectEl.dataset.testid = "ntfy-result-auth-kind";
          dropdown
            .addOptions({
              none: t("settings.authNone"),
              basic: t("settings.authBasic"),
              bearer: t("settings.authBearer"),
            })
            .setValue(result.writeAuth.kind)
            .onChange(async (kind) => {
              result.writeAuth =
                kind === "basic"
                  ? { kind: "basic", username: "", password: "" }
                  : kind === "bearer"
                    ? { kind: "bearer", token: "" }
                    : { kind: "none" };
              await this.plugin.saveSettings(true);
              this.display();
            });
        });
      this.renderNamedAuth(containerEl, result.writeAuth, true);
    }

    this.renderMessageDistributionRules(containerEl);
    const languageSetting = new Setting(containerEl)
      .setName(t("language.name"))
      .setDesc(t("language.desc"))
      .addDropdown((dropdown) => {
        dropdown.selectEl.dataset.testid = "ntfy-ui-language";
        dropdown
          .addOptions({
            auto: t("language.auto"),
            en: t("language.en"),
            "zh-CN": t("language.zhCN"),
          })
          .setValue(this.plugin.settings.uiLanguage)
          .onChange(async (value) => {
            await this.plugin.setUiLanguage(value as UiLanguageSetting);
            this.display();
          });
      });
    languageSetting.settingEl.dataset.testid = "ntfy-language-setting";

    const applySetting = new Setting(containerEl)
      .setName(t("settings.validateReconnect"))
      .addButton((button) =>
        button
          .setButtonText(t("settings.apply"))
          .setCta()
          .onClick(async () => {
            const issues = validateSettings(this.plugin.settings);
            if (issues.length) {
              const first = issues[0]!;
              new Notice(`Ntfy Sync: ${first.path}: ${localizeValidationIssue(i18n, first)}`);
              return;
            }
            await this.plugin.saveSettings(true);
            new Notice(t("notice.settingsApplied"));
          }),
      );
    applySetting.settingEl.dataset.testid = "ntfy-apply-setting";
  }

  private renderMessageDistributionRules(containerEl: HTMLElement): void {
    const { t } = this.plugin.i18n;
    const heading = new Setting(containerEl)
      .setName(t("settings.rules"))
      .setDesc(t("settings.rulesDesc"))
      .setHeading()
      .setClass("ntfy-sync-rules-heading");
    heading.settingEl.dataset.testid = "ntfy-rules-heading";
    heading.addButton((button) => {
      button.buttonEl.dataset.testid = "ntfy-rule-add";
      button
        .setButtonText(t("settings.addRule"))
        .setCta()
        .onClick(() => {
          new MessageDistributionRuleModal(this.app, this.plugin, undefined, () =>
            this.display(),
          ).open();
        });
    });

    const list = containerEl.createDiv({ cls: "ntfy-sync-rule-list" });
    list.dataset.testid = "ntfy-rule-list";
    const rules = this.plugin.settings.rules.rules;
    if (!rules.length) {
      const empty = list.createDiv({
        cls: "ntfy-sync-rule-empty",
        text: t("settings.noRules"),
      });
      empty.dataset.testid = "ntfy-rule-empty";
    }

    rules.forEach((rule, index) => this.renderRule(list, rule, index));
  }

  private renderRule(containerEl: HTMLElement, rule: RuleV1, index: number): void {
    const i18n = this.plugin.i18n;
    const { t } = i18n;
    const info = summarizeRule(rule, i18n);
    const setting = new Setting(containerEl)
      .setDesc(info.description)
      .setClass("ntfy-sync-rule-card");
    setting.nameEl.empty();
    setting.nameEl.addClass("ntfy-sync-rule-card-heading");
    const name = setting.nameEl.createSpan({
      cls: "ntfy-sync-rule-card-name",
      text: info.name,
    });
    name.dataset.testid = `ntfy-rule-name-${index}`;
    const notePath = setting.nameEl.createSpan({
      cls: "ntfy-sync-rule-card-note-path",
      text: t("settings.notePath", { path: info.notePath }),
      attr: { title: t("settings.notePath", { path: info.notePath }) },
    });
    notePath.dataset.testid = `ntfy-rule-note-path-${index}`;
    setting.settingEl.dataset.testid = `ntfy-rule-card-${index}`;
    setting.settingEl.dataset.ruleId = rule.id;
    setting.settingEl.toggleClass("is-disabled", !rule.enabled);

    setting.addToggle((toggle) => {
      toggle.toggleEl.dataset.testid = `ntfy-rule-enabled-${index}`;
      toggle
        .setTooltip(t(rule.enabled ? "settings.disableRule" : "settings.enableRule"))
        .setValue(rule.enabled)
        .onChange(async (enabled) => {
          const draft = structuredClone(rule);
          draft.enabled = enabled;
          this.plugin.settings.rules.rules = saveRuleDraft(rulesOf(this.plugin), draft, index);
          await this.plugin.saveSettings(false);
          this.display();
        });
    });
    setting.addExtraButton((button) => {
      button.extraSettingsEl.dataset.testid = `ntfy-rule-up-${index}`;
      button
        .setIcon("chevron-up")
        .setTooltip(t("settings.moveUp"))
        .setDisabled(index === 0)
        .onClick(async () => {
          this.plugin.settings.rules.rules = moveRule(rulesOf(this.plugin), index, index - 1);
          await this.plugin.saveSettings(false);
          this.display();
        });
    });
    setting.addExtraButton((button) => {
      button.extraSettingsEl.dataset.testid = `ntfy-rule-down-${index}`;
      button
        .setIcon("chevron-down")
        .setTooltip(t("settings.moveDown"))
        .setDisabled(index === rulesOf(this.plugin).length - 1)
        .onClick(async () => {
          this.plugin.settings.rules.rules = moveRule(rulesOf(this.plugin), index, index + 1);
          await this.plugin.saveSettings(false);
          this.display();
        });
    });
    setting.addExtraButton((button) => {
      button.extraSettingsEl.dataset.testid = `ntfy-rule-edit-${index}`;
      button
        .setIcon("pencil")
        .setTooltip(t("settings.edit"))
        .onClick(() => {
          new MessageDistributionRuleModal(this.app, this.plugin, index, () =>
            this.display(),
          ).open();
        });
    });
    setting.addExtraButton((button) => {
      let confirming = false;
      button.extraSettingsEl.dataset.testid = `ntfy-rule-delete-${index}`;
      button
        .setIcon("trash-2")
        .setTooltip(t("settings.delete"))
        .onClick(async () => {
          if (!confirming) {
            confirming = true;
            button.extraSettingsEl.dataset.confirming = "true";
            button.setIcon("check").setTooltip(t("settings.confirmDelete"));
            new Notice(t("notice.confirmDelete", { name: rule.name }));
            return;
          }
          this.plugin.settings.rules.rules = removeRule(rulesOf(this.plugin), index);
          await this.plugin.saveSettings(false);
          this.display();
        });
    });
  }

  private renderAuth(containerEl: HTMLElement, connection: ConnectionConfigV1): void {
    this.renderNamedAuth(containerEl, connection.readAuth, false);
  }

  private renderNamedAuth(containerEl: HTMLElement, auth: AuthConfig, result: boolean): void {
    const { t } = this.plugin.i18n;
    const scope = result ? "result-auth" : "read-auth";
    const username = result ? t("settings.resultUsername") : t("settings.username");
    const passwordLabel = result ? t("settings.resultPassword") : t("settings.password");
    const tokenLabel = result ? t("settings.resultToken") : t("settings.token");
    if (auth.kind === "basic") {
      new Setting(containerEl).setName(username).addText((text) => {
        text.inputEl.dataset.testid = `ntfy-${scope}-username`;
        text.setValue(auth.username).onChange(async (value) => {
          auth.username = value;
          await this.plugin.saveSettings(false);
        });
      });
      const password = new Setting(containerEl)
        .setName(passwordLabel)
        .setDesc(t("settings.credentialWarning"));
      password.descEl.dataset.testid = `ntfy-${scope}-credential-warning`;
      password.descEl.setAttr("role", "note");
      password.addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.dataset.testid = `ntfy-${scope}-password`;
        text.setValue(auth.password).onChange(async (value) => {
          auth.password = value;
          await this.plugin.saveSettings(false);
        });
      });
    } else if (auth.kind === "bearer") {
      const token = new Setting(containerEl)
        .setName(tokenLabel)
        .setDesc(t("settings.credentialWarning"));
      token.descEl.dataset.testid = `ntfy-${scope}-credential-warning`;
      token.descEl.setAttr("role", "note");
      token.addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.dataset.testid = `ntfy-${scope}-token`;
        text.setValue(auth.token).onChange(async (value) => {
          auth.token = value;
          await this.plugin.saveSettings(false);
        });
      });
    }
  }
}

function rulesOf(plugin: NtfySyncPlugin): RuleV1[] {
  return plugin.settings.rules.rules;
}

function setInlineValidation(setting: Setting, message: string, testId: string): void {
  setting.setDesc(message);
  setting.settingEl.addClass("is-invalid");
  setting.descEl.dataset.testid = testId;
  setting.descEl.setAttr("role", "alert");
}

function refreshResultTopicValidation(
  setting: Setting,
  resultTopic: string,
  inputTopics: readonly string[],
  invalidMessage: string,
  conflictMessage: string,
  description: string,
): void {
  if (!isValidNtfyTopic(resultTopic)) {
    setInlineValidation(setting, invalidMessage, "ntfy-result-topic-validation");
  } else if (inputTopics.includes(resultTopic)) {
    setInlineValidation(setting, conflictMessage, "ntfy-result-topic-validation");
  } else {
    clearInlineValidation(setting, description);
  }
}

function clearInlineValidation(setting: Setting, description: string): void {
  setting.setDesc(description);
  setting.settingEl.removeClass("is-invalid");
  delete setting.descEl.dataset.testid;
  setting.descEl.removeAttribute("role");
}

export function cloneAuthWithoutSecrets(auth: AuthConfig): Record<string, unknown> {
  return auth.kind === "none" ? { kind: "none" } : { kind: auth.kind, configured: true };
}
