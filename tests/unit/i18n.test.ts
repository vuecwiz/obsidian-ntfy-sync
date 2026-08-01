import {
  conditionFieldLabel,
  conditionOperatorLabel,
  createI18n,
  localizeValidationIssue,
  mimePresetLabel,
  resolvePluginLocale,
} from "../../src/i18n";
import { summarizeRule } from "../../src/settings/rule-editor";
import type { RuleV1 } from "../../src/domain/types";

describe("plugin interface localization", () => {
  it("resolves explicit and host-following language preferences", () => {
    expect(resolvePluginLocale("auto", "zh-Hans")).toBe("zh-CN");
    expect(resolvePluginLocale("auto", "en-US")).toBe("en");
    expect(resolvePluginLocale("en", "zh-CN")).toBe("en");
    expect(resolvePluginLocale("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("translates labels, interpolation and MIME presets", () => {
    const zh = createI18n("zh-CN", "en");
    const en = createI18n("en", "zh-CN");
    expect(zh.t("rule.condition", { number: 2 })).toBe("条件 2");
    expect(conditionFieldLabel(zh, "attachmentMime")).toBe("附件 MIME 类型");
    expect(conditionOperatorLabel(zh, "attachmentMime", "startsWith")).toBe("开头为");
    expect(mimePresetLabel(zh, "image/png", "PNG image")).toBe("PNG 图片");
    expect(en.t("settings.rulesDesc")).toBe(
      "Rules are checked from top to bottom; the first enabled match wins.",
    );
    expect(zh.t("settings.rulesDesc")).toBe("规则从上到下依次检查，首个启用且匹配的规则生效。");
    expect(en.t("settings.publishTest")).toBe("Publish test");
    expect(zh.t("publishTest.title")).toBe("发布测试消息");
    expect(zh.t("publishTest.messageRequired")).toBe("请输入要发布的内容。");
    expect(en.t("ribbon.openComposer")).toBe("Ntfy message composer");
    expect(zh.t("ribbon.openComposer")).toBe("Ntfy消息发送器");
  });

  it("localizes rule summaries without translating user values", () => {
    const rule: RuleV1 = {
      id: "example",
      revision: 1,
      name: "Example rule",
      enabled: false,
      when: { all: [{ field: "tag", op: "contains", value: "example-tag" }] },
      action: {
        notePathTemplate: "Examples/Inbox.md",
        contentTemplateId: "inbox",
        insertion: "append",
      },
    };
    expect(summarizeRule(rule, createI18n("zh-CN", "en"))).toEqual({
      name: "Example rule",
      notePath: "Examples/Inbox.md",
      description: "已禁用 · 包含标签 是 “example-tag”",
    });
  });

  it("keeps authoritative English validation details and localizes Chinese issues safely", () => {
    const issue = { path: "rules.rules[0].name", code: "NAME", message: "Name is required" };
    expect(localizeValidationIssue(createI18n("en", "zh"), issue)).toBe("Name is required");
    expect(localizeValidationIssue(createI18n("zh-CN", "en"), issue)).toBe("必须填写名称");
  });
});
