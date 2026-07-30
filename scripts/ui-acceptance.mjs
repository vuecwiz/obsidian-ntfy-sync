import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { installTestVault } from "./install-test-vault.mjs";
import { ObsidianCliTimeoutError, runObsidianCli } from "./obsidian-cli-runner.mjs";
import { captureStableScreenshot } from "./ui-screenshot.mjs";
import {
  normalizeDesktopViewport,
  restoreViewport,
  waitForStableLayout,
} from "./ui-runner-viewport.mjs";

const runId =
  process.env.NTFY_UI_RUN_ID ?? `rules-ui-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const documentScreenshots = process.env.NTFY_UI_DOC_SCREENSHOTS === "1";
const pluginLanguage = process.env.NTFY_UI_PLUGIN_LANGUAGE ?? "en";
assertSupportedLanguage(pluginLanguage);
const expectedHostLanguage = process.env.NTFY_UI_EXPECTED_OBSIDIAN_LANGUAGE;
const ui =
  pluginLanguage === "zh-CN"
    ? {
        addTitle: "添加消息分发规则",
        editTitle: "编辑消息分发规则",
        tagLabel: "包含标签",
        mimePlaceholder: "搜索或输入 MIME 类型",
        mimeAria: "附件 MIME 类型",
        noConditions: "没有条件时，此规则匹配所有消息。",
        nameRequired: "必须填写名称",
        credentialNames: ["密码", "令牌", "结果密码", "结果令牌"],
        languageLabel: "插件语言",
      }
    : {
        addTitle: "Add message distribution rule",
        editTitle: "Edit message distribution rule",
        tagLabel: "Has tag",
        mimePlaceholder: "Search or enter a MIME type",
        mimeAria: "Attachment MIME type",
        noConditions: "No conditions means this rule matches all messages.",
        nameRequired: "Rule name is required",
        credentialNames: ["Password", "Token", "Result password", "Result token"],
        languageLabel: "Language",
      };
const marker = randomBytes(5).toString("hex");
const draftName = documentScreenshots
  ? pluginLanguage === "zh-CN"
    ? "示例复验规则"
    : "Example review rule"
  : `UI acceptance ${marker}`;
const editedName = `${draftName} edited`;
const artifactRoot = process.env.NTFY_UI_ARTIFACT_ROOT ?? join(".artifacts", "ui-automation");
const artifactDirectory = join(artifactRoot, runId);
await mkdir(artifactDirectory, { recursive: true });

const checks = {};
const screenshotEvidence = {};
let debugAttached = false;
let originalData;
let dataPath;
let backupPath;
let vaultName;
let viewportEvidence;
let observedHostLanguage;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSupportedLanguage(value) {
  if (value !== "en" && value !== "zh-CN") {
    throw new Error(`Unsupported NTFY_UI_PLUGIN_LANGUAGE: ${value}`);
  }
}

async function removeFileIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function obsidian(...args) {
  return runObsidianCli(vaultName, args);
}

async function evaluate(code) {
  const output = await obsidian("eval", `code=${code}`);
  const line = output.split(/\r?\n/).findLast((candidate) => candidate.startsWith("=> "));
  return line?.slice(3);
}

async function evaluateRead(code) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await evaluate(code);
    } catch (error) {
      if (!(error instanceof ObsidianCliTimeoutError) || attempt === 1) throw error;
    }
  }
  throw new Error("Obsidian read evaluation retry exhausted");
}

async function evaluateJson(code) {
  const output = await evaluateRead(code);
  if (!output) throw new Error("Obsidian eval returned no JSON result");
  return JSON.parse(output);
}

async function cdp(method, params) {
  return obsidian("dev:cdp", `method=${method}`, `params=${JSON.stringify(params)}`);
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function captureScreenshot(path, label, readyExpression) {
  const evidence = await captureStableScreenshot({
    path,
    label,
    cdp,
    readState: () => readScreenshotState(label, readyExpression),
  });
  screenshotEvidence[basename(path)] = evidence;
}

async function readScreenshotState(label, readyExpression) {
  return evaluateJson(`
    (() => {
      const byId = (id) => document.querySelector('[data-testid="' + id + '"]');
      const visible = (element) => Boolean(
        element && element.getClientRects().length > 0 &&
        element.getBoundingClientRect().bottom > 0 &&
        element.getBoundingClientRect().top < innerHeight
      );
      const root = document.querySelector('.ntfy-sync-settings');
      const scroll = root;
      const ruleModal = byId('ntfy-rule-modal');
      const modalTitle = ruleModal?.querySelector('.modal-title')?.textContent ?? '';
      const tooltip = document.querySelector('.tooltip.ntfy-sync-status-tooltip');
      const suggestion = document.querySelector('.ntfy-sync-mime-suggestion-container');
      const visibleSuggestions = [...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
        .filter((item) => visible(item));
      const applySetting = byId('ntfy-apply-setting')?.closest('.setting-item');
      const geometry = [...document.querySelectorAll('.ntfy-sync-settings [data-testid], [data-testid="ntfy-rule-modal"] [data-testid], .ntfy-sync-status-tooltip')]
        .filter((element) => visible(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return [element.dataset.testid ?? element.className, Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)];
        });
      const safeValues = [...document.querySelectorAll('.ntfy-sync-settings input, [data-testid="ntfy-rule-modal"] input, [data-testid="ntfy-rule-modal"] select')]
        .filter((element) => element.type !== 'password')
        .map((element) => [element.dataset.testid ?? '', element.value]);
      const signatureSource = JSON.stringify({
        active: app.setting.activeTab?.id,
        scrollTop: Math.round(scroll?.scrollTop ?? 0),
        modalTitle,
        tooltipTitle: tooltip?.querySelector('.ntfy-sync-status-tooltip-title')?.textContent ?? '',
        tooltipRows: tooltip?.querySelectorAll('.ntfy-sync-status-tooltip-row').length ?? 0,
        suggestionPlacement: suggestion?.dataset.placement ?? '',
        suggestions: visibleSuggestions.map((item) => item.dataset.mimeValue),
        text: root?.innerText ?? '',
        geometry,
        safeValues
      });
      let hash = 2166136261;
      for (let index = 0; index < signatureSource.length; index += 1) {
        hash ^= signatureSource.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return JSON.stringify({
        ready: Boolean(${readyExpression}),
        signature: {
          scene: ${JSON.stringify(label)},
          domHash: (hash >>> 0).toString(16).padStart(8, '0'),
          scrollTop: Math.round(scroll?.scrollTop ?? 0),
          modalTitle,
          tooltipRows: tooltip?.querySelectorAll('.ntfy-sync-status-tooltip-row').length ?? 0,
          suggestionPlacement: suggestion?.dataset.placement ?? '',
          suggestionCount: visibleSuggestions.length
        }
      });
    })()
  `);
}

async function openSettings() {
  await evaluate(`
    app.setting.open();
    app.setting.openTabById("telegram-sync");
    app.setting.openTabById("ntfy-sync");
    "settings-opened";
  `);
  await waitForStableLayout(evaluateJson, ".ntfy-sync-settings");
  return evaluateJson(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      const rulesHeading = document.querySelector('[data-testid="ntfy-rules-heading"]');
      const rulesHeadingName = rulesHeading?.querySelector(".setting-item-name");
      const addRule = document.querySelector('[data-testid="ntfy-rule-add"]');
      const ruleList = document.querySelector('[data-testid="ntfy-rule-list"]');
      const firstRuleCard = document.querySelector('[data-testid="ntfy-rule-card-0"]');
      const languageSetting = document.querySelector('[data-testid="ntfy-language-setting"]');
      const applySetting = document.querySelector('[data-testid="ntfy-apply-setting"]');
      const ruleCards = [...document.querySelectorAll('.ntfy-sync-rule-card')];
      const aligned = (first, second) => Math.abs(first - second) <= 0.5;
      const textRect = (element) => {
        if (!element) return undefined;
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
      };
      const rulesHeadingTextRect = textRect(rulesHeadingName);
      const addRuleRect = addRule?.getBoundingClientRect();
      return JSON.stringify({
        active: app.setting.activeTab?.id,
        manifestName: plugin.manifest.name,
        tabName: app.setting.activeTab?.name,
        heading: document.querySelector('[data-testid="ntfy-settings-heading"] .setting-item-name')?.textContent,
        ruleCount: plugin.settings.rules.rules.length,
        cardCount: document.querySelectorAll(".ntfy-sync-rule-card").length,
        addCount: document.querySelectorAll('[data-testid="ntfy-rule-add"]').length,
        addInHeading: Boolean(addRule && rulesHeading?.contains(addRule)),
        addRightOfTitle: Boolean(
          addRuleRect &&
          rulesHeadingTextRect &&
          addRuleRect.left > rulesHeadingTextRect.right &&
          addRuleRect.top < rulesHeadingTextRect.bottom &&
          addRuleRect.bottom > rulesHeadingTextRect.top
        ),
        ruleListAligned: Boolean(
          ruleList &&
          rulesHeadingName &&
          addRule &&
          aligned(ruleList.getBoundingClientRect().left, rulesHeadingName.getBoundingClientRect().left) &&
          aligned(ruleList.getBoundingClientRect().right, addRule.getBoundingClientRect().right)
        ),
        firstCardFillsList: Boolean(
          firstRuleCard &&
          ruleList &&
          aligned(firstRuleCard.getBoundingClientRect().left, ruleList.getBoundingClientRect().left) &&
          aligned(firstRuleCard.getBoundingClientRect().right, ruleList.getBoundingClientRect().right)
        ),
        compactRuleHeadings: ruleCards.length > 0 && ruleCards.every((card, index) => {
          const name = card.querySelector('[data-testid="ntfy-rule-name-' + index + '"]');
          const notePath = card.querySelector('[data-testid="ntfy-rule-note-path-' + index + '"]');
          const description = card.querySelector('.setting-item-description');
          if (!name || !notePath || notePath.parentElement !== name.parentElement) return false;
          const nameRect = name.getBoundingClientRect();
          const pathRect = notePath.getBoundingClientRect();
          const sharesRow = pathRect.top < nameRect.bottom && pathRect.bottom > nameRect.top;
          return sharesRow && notePath.hasAttribute('title') && !description?.contains(notePath);
        }),
        advancedCount: document.querySelectorAll('[data-testid="ntfy-advanced-json"]').length,
        rawJsonControlCount: document.querySelectorAll(
          '[data-testid="ntfy-rules-json"], [data-testid="ntfy-templates-json"]'
        ).length,
        languageImmediatelyBeforeApply: Boolean(
          languageSetting && applySetting && languageSetting.nextElementSibling === applySetting
        ),
        applyIsLastSetting: Boolean(applySetting && applySetting.nextElementSibling === null),
        statusCount: document.querySelectorAll('[data-testid="ntfy-sync-status"]').length,
        statusState: document.querySelector('[data-testid="ntfy-sync-status"]')?.dataset.status,
        statusSvg: Boolean(document.querySelector('[data-testid="ntfy-sync-status"] svg')),
        statusTooltip: document.querySelector('[data-testid="ntfy-sync-status"]')?.getAttribute("aria-label") ?? ""
      });
    })()
  `);
}

async function click(testId) {
  await evaluate(`document.querySelector('[data-testid="${testId}"]')?.click(); "clicked"`);
}

async function setInput(testId, value, eventName = "input") {
  await evaluate(`
    (() => {
      const input = document.querySelector('[data-testid="${testId}"]');
      if (!input) throw new Error("missing ${testId}");
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
      return "changed";
    })()
  `);
}

async function openMimeSuggestions(index, query = "") {
  await evaluateRead(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-rule-condition-value-${index}"]');
      if (!input) throw new Error("missing MIME search input ${index}");
      const wasFocused = document.activeElement === input;
      input.value = ${JSON.stringify(query)};
      if (wasFocused) input.dispatchEvent(new Event("input", { bubbles: true }));
      else {
        input.focus();
        setTimeout(() => {
          const hasSuggestions = [...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
            .some((item) => item.getClientRects().length > 0);
          if (!hasSuggestions) input.dispatchEvent(new Event("input", { bubbles: true }));
        }, 0);
      }
      return "opened";
    })()
  `);
}

async function selectMimeSuggestion(value) {
  await evaluate(`
    (() => {
      const suggestion = [...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
        .find((item) => item.dataset.mimeValue === ${JSON.stringify(value)});
      if (!suggestion) throw new Error("missing MIME suggestion ${value}");
      suggestion.click();
      return "selected";
    })()
  `);
}

try {
  const installation = await installTestVault();
  vaultName = installation.vaultName;
  assert(/test/i.test(basename(installation.vault)), "UI acceptance requires a test Vault");
  dataPath = resolve(installation.destination, "data.json");
  backupPath = resolve(installation.destination, "data.ui-acceptance-backup.json");
  try {
    const strandedBackup = await readFile(backupPath);
    await writeFile(dataPath, strandedBackup, { mode: 0o600 });
    await removeFileIfPresent(backupPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  originalData = await readFile(dataPath);
  await writeFile(backupPath, originalData, { mode: 0o600 });
  const baseline = JSON.parse(originalData.toString("utf8"));
  const baselineCount = baseline.rules.rules.length;
  const acceptanceBaseline = structuredClone(baseline);
  acceptanceBaseline.enabled = false;
  acceptanceBaseline.uiLanguage = pluginLanguage;
  for (const connection of acceptanceBaseline.connections) {
    connection.readAuth = { kind: "none" };
    connection.result = undefined;
    if (documentScreenshots) {
      connection.baseUrl = "https://ntfy.sh";
      connection.topics = ["example-topic"];
    }
  }
  if (documentScreenshots) {
    acceptanceBaseline.rules.rules.forEach((rule, index) => {
      rule.name =
        pluginLanguage === "zh-CN" ? `示例规则 ${index + 1}` : `Example rule ${index + 1}`;
      rule.action.notePathTemplate =
        pluginLanguage === "zh-CN" ? `示例/规则-${index + 1}.md` : `Examples/rule-${index + 1}.md`;
      delete rule.action.attachmentPathTemplate;
      for (const condition of rule.when.all) {
        if (typeof condition.value === "string") condition.value = "example.invalid";
      }
    });
  }
  await writeFile(dataPath, `${JSON.stringify(acceptanceBaseline, null, 2)}\n`);
  checks.acceptanceCredentialsSanitized = true;

  try {
    await obsidian("dev:debug", "off");
  } catch {
    // A fresh Obsidian session has no debugger to detach.
  }
  await obsidian("plugin:reload", "id=ntfy-sync");
  await obsidian("dev:debug", "on");
  debugAttached = true;

  await evaluate(`
    (() => {
      document.getElementById("ntfy-ui-review-privacy-mask")?.remove();
      if (${JSON.stringify(documentScreenshots)}) {
        const style = document.createElement("style");
        style.id = "ntfy-ui-review-privacy-mask";
        style.textContent =
          ".workspace, .notice-container { visibility: hidden !important; }";
        document.head.append(style);
      }
      document.querySelectorAll('.tooltip.ntfy-sync-status-tooltip').forEach((tooltip) => tooltip.remove());
      document.querySelectorAll('[data-testid="ntfy-rule-cancel"]').forEach((button) => button.click());
      return "stale-modals-closed";
    })()
  `);

  viewportEvidence = await normalizeDesktopViewport({ cdp, evaluateJson });
  checks.desktopViewportNormalized = true;
  checks.desktopViewportWidth = viewportEvidence.normalized.innerWidth;
  checks.desktopViewportHeight = viewportEvidence.normalized.innerHeight;
  checks.rootFontPx = viewportEvidence.normalized.rootFontPx;
  if (viewportEvidence.simulatedInitial) {
    checks.initialViewportWasNarrow = viewportEvidence.before.narrow;
  }

  const opened = await openSettings();
  const hostAndPluginLanguage = await evaluateJson(`
    JSON.stringify({
      host: document.documentElement.lang,
      preference: app.plugins.getPlugin("ntfy-sync").settings.uiLanguage,
      locale: document.querySelector(".ntfy-sync-settings")?.dataset.locale
    })
  `);
  observedHostLanguage = hostAndPluginLanguage.host;
  if (expectedHostLanguage) {
    assert(
      hostAndPluginLanguage.host
        .toLocaleLowerCase()
        .startsWith(expectedHostLanguage.toLocaleLowerCase()),
      `Obsidian host language ${hostAndPluginLanguage.host} does not match ${expectedHostLanguage}`,
    );
  }
  assert(
    hostAndPluginLanguage.preference === pluginLanguage &&
      hostAndPluginLanguage.locale === pluginLanguage,
    `target plugin language was not applied: ${JSON.stringify(hostAndPluginLanguage)}`,
  );
  assert(opened.active === "ntfy-sync", "Ntfy Sync setting tab did not open");
  assert(
    opened.manifestName === "Ntfy Sync" &&
      opened.tabName === "Ntfy Sync" &&
      opened.heading === "Ntfy Sync",
    "Ntfy Sync display name is inconsistent",
  );
  assert(opened.ruleCount === baselineCount, "runtime rule count differs from persisted baseline");
  assert(opened.cardCount === baselineCount, "rule card count differs from stored rules");
  assert(opened.addCount === 1, "Add rule button is missing or duplicated");
  assert(opened.addInHeading && opened.addRightOfTitle, "Add rule is not right-aligned in heading");
  assert(
    opened.ruleListAligned && opened.firstCardFillsList,
    "rule cards do not align with the heading title and Add rule button",
  );
  assert(opened.compactRuleHeadings, "rule names and note paths do not share one card row");
  assert(
    opened.advancedCount === 0 && opened.rawJsonControlCount === 0,
    "raw rules/templates JSON controls remain visible",
  );
  assert(
    opened.languageImmediatelyBeforeApply && opened.applyIsLastSetting,
    "plugin language is not immediately above the final Apply setting",
  );
  checks.settingsOpened = true;
  checks.rawJsonSettingsRemoved = true;
  checks.addRuleInHeading = true;
  checks.ruleListAlignedWithHeading = true;
  checks.ruleNameAndNotePathShareRow = true;
  checks.languageImmediatelyBeforeApply = true;
  checks.displayNameCapitalized = true;
  checks.baselineRuleCount = baselineCount;

  await setInput("ntfy-ui-language", "zh-CN", "change");
  await waitFor(async () => {
    const state = await evaluateJson(`
      (() => {
        const plugin = app.plugins.getPlugin("ntfy-sync");
        const root = document.querySelector(".ntfy-sync-settings");
        return JSON.stringify({
          saved: plugin.settings.uiLanguage,
          locale: root?.dataset.locale,
          languageLabel: document.querySelector('[data-testid="ntfy-language-setting"] .setting-item-name')?.textContent,
          rulesLabel: document.querySelector('[data-testid="ntfy-rules-heading"] .setting-item-name')?.textContent,
          status: document.querySelector('[data-testid="ntfy-sync-status"]')?.getAttribute("aria-label")
        });
      })()
    `);
    return (
      state.saved === "zh-CN" &&
      state.locale === "zh-CN" &&
      state.languageLabel === "插件语言" &&
      state.rulesLabel === "消息分发规则" &&
      state.status?.startsWith("Ntfy Sync — 已关闭")
    );
  }, "immediate Simplified Chinese settings and status localization");
  await click("ntfy-rule-add");
  const chineseModal = await evaluateJson(`
    (() => {
      const modal = document.querySelector('[data-testid="ntfy-rule-modal"]');
      return JSON.stringify({
        locale: modal?.dataset.locale,
        title: modal?.querySelector('.modal-title')?.textContent,
        ruleName: modal?.querySelector('[data-testid="ntfy-rule-name"]')
          ?.closest('.setting-item')?.querySelector('.setting-item-name')?.textContent,
        addCondition: modal?.querySelector('[data-testid="ntfy-rule-add-condition"]')?.textContent,
        save: modal?.querySelector('[data-testid="ntfy-rule-save"]')?.textContent
      });
    })()
  `);
  assert(
    chineseModal.locale === "zh-CN" &&
      chineseModal.title === "添加消息分发规则" &&
      chineseModal.ruleName === "规则名称" &&
      chineseModal.addCondition === "添加条件" &&
      chineseModal.save === "保存规则",
    "rule modal did not switch completely to Simplified Chinese",
  );
  await click("ntfy-rule-cancel");
  await obsidian("plugin:reload", "id=ntfy-sync");
  await openSettings();
  const chineseReload = await evaluateJson(`
    (() => {
      const commands = app.commands.commands;
      return JSON.stringify({
        saved: app.plugins.getPlugin("ntfy-sync").settings.uiLanguage,
        locale: document.querySelector(".ntfy-sync-settings")?.dataset.locale,
        reconnect: commands["ntfy-sync:reconnect"]?.name,
        diagnostics: commands["ntfy-sync:export-diagnostics"]?.name
      });
    })()
  `);
  assert(
    chineseReload.saved === "zh-CN" &&
      chineseReload.locale === "zh-CN" &&
      chineseReload.reconnect === "Ntfy Sync: 重新连接" &&
      chineseReload.diagnostics === "Ntfy Sync: 导出脱敏诊断信息",
    "Simplified Chinese selection or command labels did not survive plugin reload",
  );
  await setInput("ntfy-ui-language", "en", "change");
  await waitFor(async () => {
    const state = await evaluateJson(`
      JSON.stringify({
        saved: app.plugins.getPlugin("ntfy-sync").settings.uiLanguage,
        locale: document.querySelector(".ntfy-sync-settings")?.dataset.locale,
        languageLabel: document.querySelector('[data-testid="ntfy-language-setting"] .setting-item-name')?.textContent
      })
    `);
    return state.saved === "en" && state.locale === "en" && state.languageLabel === "Language";
  }, "English plugin language restoration");
  if (pluginLanguage === "zh-CN") {
    await setInput("ntfy-ui-language", "zh-CN", "change");
    await waitFor(async () => {
      const state = await evaluateJson(`
        JSON.stringify({
          saved: app.plugins.getPlugin("ntfy-sync").settings.uiLanguage,
          locale: document.querySelector(".ntfy-sync-settings")?.dataset.locale,
          languageLabel: document.querySelector('[data-testid="ntfy-language-setting"] .setting-item-name')?.textContent
        })
      `);
      return (
        state.saved === "zh-CN" && state.locale === "zh-CN" && state.languageLabel === "插件语言"
      );
    }, "Simplified Chinese target language restoration");
  }
  checks.languageSwitchImmediate = true;
  checks.chineseRuleModalLocalized = true;
  checks.languageReloadPersistence = true;
  checks.localizedCommandNamesAfterReload = true;
  checks.englishLanguageRestored = true;
  checks.targetPluginLanguageApplied = true;

  const topicValidation = await evaluateJson(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      const input = document.querySelector('[data-testid="ntfy-topics"]');
      const before = JSON.stringify(plugin.settings.connections[0].topics);
      input.value = "invalid/topic";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const validation = document.querySelector('[data-testid="ntfy-topics-validation"]');
      const result = {
        unchanged: JSON.stringify(plugin.settings.connections[0].topics) === before,
        invalidClass: input.closest(".setting-item")?.classList.contains("is-invalid") ?? false,
        alert: validation?.getAttribute("role") === "alert",
        messageMentionsConstraint: validation?.textContent?.includes("64") ?? false
      };
      input.value = plugin.settings.connections[0].topics.join(", ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      result.cleared = !document.querySelector('[data-testid="ntfy-topics-validation"]');
      return JSON.stringify(result);
    })()
  `);
  assert(
    topicValidation.unchanged &&
      topicValidation.invalidClass &&
      topicValidation.alert &&
      topicValidation.messageMentionsConstraint &&
      topicValidation.cleared,
    "invalid topic input was not rejected and restored cleanly",
  );
  checks.topicConstraintValidation = true;
  if (documentScreenshots) {
    await evaluate(`
      document.querySelector('.ntfy-sync-settings')?.scrollTo({ top: 0 });
      "scrolled";
    `);
    await captureScreenshot(
      resolve(artifactDirectory, "documentation-general-settings.png"),
      "general-settings",
      `root && app.setting.activeTab?.id === 'ntfy-sync' && !ruleModal && !tooltip && !suggestion && (scroll?.scrollTop ?? 1) <= 1 && visible(byId('ntfy-server-url'))`,
    );
    await evaluate(`
      document.querySelector('[data-testid="ntfy-rules-heading"]')?.scrollIntoView({ block: "start" });
      "scrolled";
    `);
    await captureScreenshot(
      resolve(artifactDirectory, "documentation-rule-list.png"),
      "message-distribution-rules",
      `root && !ruleModal && !tooltip && visible(byId('ntfy-rules-heading')) && (scroll?.scrollTop ?? 0) > 1`,
    );
    checks.documentationScreenshotsCaptured = true;
  }
  const initialQuickToggle = await evaluateJson(`
    (() => {
      const rule = app.plugins.getPlugin("ntfy-sync").settings.rules.rules[0];
      return JSON.stringify({ enabled: rule.enabled, revision: rule.revision });
    })()
  `);
  await click("ntfy-rule-enabled-0");
  await waitFor(async () => {
    const toggled = await evaluateJson(`
      (() => {
        const plugin = app.plugins.getPlugin("ntfy-sync");
        const rule = plugin.settings.rules.rules[0];
        const card = document.querySelector('[data-testid="ntfy-rule-card-0"]');
        return JSON.stringify({
          enabled: rule.enabled,
          revision: rule.revision,
          disabledCard: card?.classList.contains("is-disabled")
        });
      })()
    `);
    return (
      toggled.enabled === !initialQuickToggle.enabled &&
      toggled.revision === initialQuickToggle.revision + 1 &&
      toggled.disabledCard === initialQuickToggle.enabled
    );
  }, "rule quick disable/enable persistence");
  await click("ntfy-rule-enabled-0");
  await waitFor(async () => {
    const restored = await evaluateJson(`
      (() => {
        const plugin = app.plugins.getPlugin("ntfy-sync");
        const rule = plugin.settings.rules.rules[0];
        const card = document.querySelector('[data-testid="ntfy-rule-card-0"]');
        return JSON.stringify({
          enabled: rule.enabled,
          revision: rule.revision,
          disabledCard: card?.classList.contains("is-disabled")
        });
      })()
    `);
    return (
      restored.enabled === initialQuickToggle.enabled &&
      restored.revision === initialQuickToggle.revision + 2 &&
      restored.disabledCard === !initialQuickToggle.enabled
    );
  }, "rule quick toggle restoration");
  checks.ruleQuickEnableToggle = true;
  const credentialWarningLayout = await evaluateJson(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      const tab = app.setting.activeTab;
      const connection = plugin.settings.connections[0];
      const originalReadAuth = connection.readAuth;
      const originalResult = connection.result;
      const inspect = (scope, field) => {
        const warning = document.querySelector(
          '[data-testid="ntfy-' + scope + '-credential-warning"]'
        );
        const input = document.querySelector('[data-testid="ntfy-' + scope + '-' + field + '"]');
        const warningSetting = warning?.closest(".setting-item");
        const inputSetting = input?.closest(".setting-item");
        return {
          warningCount: document.querySelectorAll(
            '[data-testid="ntfy-' + scope + '-credential-warning"]'
          ).length,
          settingName: warningSetting?.querySelector(".setting-item-name")?.textContent ?? "",
          sameSetting: Boolean(warningSetting && warningSetting === inputSetting),
          descriptionClass: warning?.classList.contains("setting-item-description") ?? false,
          inputType: input?.type ?? "",
          role: warning?.getAttribute("role") ?? ""
        };
      };

      connection.readAuth = { kind: "basic", username: "", password: "" };
      connection.result = undefined;
      tab.display();
      const readBasic = inspect("read-auth", "password");
      connection.readAuth = { kind: "bearer", token: "" };
      tab.display();
      const readBearer = inspect("read-auth", "token");
      connection.readAuth = { kind: "none" };
      tab.display();
      const readNone = document.querySelectorAll(
        '[data-testid="ntfy-read-auth-credential-warning"]'
      ).length;

      connection.result = {
        topic: "",
        writeAuth: { kind: "basic", username: "", password: "" },
        privacy: "minimal",
        cache: true
      };
      tab.display();
      const resultBasic = inspect("result-auth", "password");
      connection.result.writeAuth = { kind: "bearer", token: "" };
      tab.display();
      const resultBearer = inspect("result-auth", "token");
      connection.result.writeAuth = { kind: "none" };
      tab.display();
      const resultNone = document.querySelectorAll(
        '[data-testid="ntfy-result-auth-credential-warning"]'
      ).length;

      connection.readAuth = originalReadAuth;
      connection.result = originalResult;
      tab.display();
      return JSON.stringify({
        readBasic,
        readBearer,
        readNone,
        resultBasic,
        resultBearer,
        resultNone,
        standaloneWarningCount: document.querySelectorAll(
          '.ntfy-sync-settings > [data-testid$="credential-warning"]'
        ).length,
        restoredRuleCards: document.querySelectorAll(".ntfy-sync-rule-card").length
      });
    })()
  `);
  for (const [layout, expectedName] of [
    [credentialWarningLayout.readBasic, ui.credentialNames[0]],
    [credentialWarningLayout.readBearer, ui.credentialNames[1]],
    [credentialWarningLayout.resultBasic, ui.credentialNames[2]],
    [credentialWarningLayout.resultBearer, ui.credentialNames[3]],
  ]) {
    assert(
      layout.warningCount === 1 &&
        layout.settingName === expectedName &&
        layout.sameSetting &&
        layout.descriptionClass &&
        layout.inputType === "password" &&
        layout.role === "note",
      `credential warning is not inside the ${expectedName} setting`,
    );
  }
  assert(
    credentialWarningLayout.readNone === 0 && credentialWarningLayout.resultNone === 0,
    "credential warning is visible when authentication is disabled",
  );
  assert(
    credentialWarningLayout.standaloneWarningCount === 0,
    "credential warning is rendered as a standalone page element",
  );
  assert(
    credentialWarningLayout.restoredRuleCards === baselineCount,
    "credential layout probe did not restore the settings page",
  );
  checks.credentialWarningsFollowSensitiveFields = true;
  await evaluate(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      const connection = plugin.settings.connections[0];
      connection.readAuth = { kind: "basic", username: "", password: "" };
      app.setting.activeTab.display();
      for (const input of document.querySelectorAll(".ntfy-sync-settings input")) {
        input.value = "";
      }
      document
        .querySelector('[data-testid="ntfy-read-auth-credential-warning"]')
        ?.scrollIntoView({ block: "center" });
      return "credential screenshot ready";
    })()
  `);
  const credentialScreenshotPath = resolve(artifactDirectory, "credential-description.png");
  await captureScreenshot(
    credentialScreenshotPath,
    "credential-descriptions",
    `root && !ruleModal && visible(byId('ntfy-read-auth-credential-warning')) && visible(byId('ntfy-read-auth-password'))`,
  );
  await evaluate(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      plugin.settings.connections[0].readAuth = { kind: "none" };
      app.setting.activeTab.display();
      return "credential screenshot restored";
    })()
  `);
  checks.credentialDescriptionScreenshotCaptured = true;
  assert(opened.statusCount === 1 && opened.statusSvg, "status bar icon is missing or duplicated");
  assert(
    [
      "off",
      "monitor_only",
      "idle",
      "connecting",
      "connected",
      "polling",
      "backoff",
      "error",
    ].includes(opened.statusState),
    "status bar has an unknown state",
  );
  assert(opened.statusTooltip.startsWith("Ntfy Sync — "), "status tooltip summary is missing");
  await evaluate(`
    (() => {
      const element = document.querySelector('[data-testid="ntfy-sync-status"]');
      const rect = element.getBoundingClientRect();
      for (const type of ["pointerenter", "pointerover", "mouseenter", "mouseover", "mousemove"]) {
        const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        element.dispatchEvent(new EventType(type, {
          bubbles: true,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
          view: window,
          pointerType: "mouse"
        }));
      }
      return "hovered";
    })()
  `);
  await waitFor(async () => {
    const tooltip = await evaluateJson(`
      JSON.stringify({
        count: document.querySelectorAll(".tooltip.ntfy-sync-status-tooltip").length,
        title: document.querySelector(".ntfy-sync-status-tooltip-title")?.textContent ?? "",
        rows: document.querySelectorAll(".ntfy-sync-status-tooltip-row").length
      })
    `);
    return tooltip.count === 1 && tooltip.title.startsWith("Ntfy Sync — ") && tooltip.rows >= 8;
  }, "status tooltip");
  const tooltipColumns = await evaluateJson(`
    (() => {
      const tooltip = document.querySelector(".tooltip.ntfy-sync-status-tooltip");
      const rows = [...document.querySelectorAll(".ntfy-sync-status-tooltip-row")];
      const labels = rows.map((row) => row.querySelector(".ntfy-sync-status-tooltip-label"));
      const values = rows.map((row) => row.querySelector(".ntfy-sync-status-tooltip-value"));
      const aligned = (positions) =>
        positions.length > 0 && positions.every((position) => Math.abs(position - positions[0]) <= 0.5);
      return JSON.stringify({
        titleCount: tooltip?.querySelectorAll(":scope > .ntfy-sync-status-tooltip-title").length ?? 0,
        rowCount: rows.length,
        labelsLeftAligned: aligned(labels.map((label) => label?.getBoundingClientRect().left ?? -1)),
        valuesRightAligned: aligned(values.map((value) => value?.getBoundingClientRect().right ?? -1)),
        labelsAreLeftOfValues: rows.every((row) => {
          const label = row.querySelector(".ntfy-sync-status-tooltip-label");
          const value = row.querySelector(".ntfy-sync-status-tooltip-value");
          return Boolean(label && value && label.getBoundingClientRect().left < value.getBoundingClientRect().right);
        }),
        contentContained: Boolean(
          tooltip &&
          rows.length > 0 &&
          rows.at(-1).getBoundingClientRect().bottom <=
            tooltip.getBoundingClientRect().bottom + 0.5
        ),
        labelsContainColon: labels.some((label) => label?.textContent?.includes(":")),
        ariaLabelPreserved: document
          .querySelector('[data-testid="ntfy-sync-status"]')
          ?.getAttribute("aria-label")
          ?.startsWith("Ntfy Sync — ") ?? false
      });
    })()
  `);
  assert(
    tooltipColumns.titleCount === 1 &&
      tooltipColumns.rowCount >= 8 &&
      tooltipColumns.labelsLeftAligned &&
      tooltipColumns.valuesRightAligned &&
      tooltipColumns.labelsAreLeftOfValues &&
      tooltipColumns.contentContained &&
      !tooltipColumns.labelsContainColon &&
      tooltipColumns.ariaLabelPreserved,
    "status tooltip labels and values are not aligned in columns",
  );
  await captureScreenshot(
    resolve(artifactDirectory, "status-tooltip-columns.png"),
    "status-tooltip-columns",
    `tooltip && tooltip.querySelectorAll('.ntfy-sync-status-tooltip-row').length >= 8 && !ruleModal`,
  );
  checks.statusIndicatorAndTooltip = true;
  checks.statusTooltipColumnsAligned = true;
  checks.statusTooltipScreenshotCaptured = true;
  await evaluate(`
    (() => {
      app.setting.close();
      const element = document.querySelector('[data-testid="ntfy-sync-status"]');
      if (!element) throw new Error("status indicator is missing");
      element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, view: window }));
      return "double-clicked";
    })()
  `);
  await waitFor(async () => {
    const state = await evaluateJson(`
      JSON.stringify({
        active: app.setting.activeTab?.id,
        rootCount: document.querySelectorAll(".ntfy-sync-settings").length
      })
    `);
    return state.active === "ntfy-sync" && state.rootCount === 1;
  }, "status double-click settings navigation");
  checks.statusDoubleClickOpensSettings = true;
  await evaluate(`
    (() => {
      app.setting.close();
      const element = document.querySelector('[data-testid="ntfy-sync-status"]');
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return "pressed";
    })()
  `);
  await waitFor(async () => {
    const state = await evaluateJson(`
      JSON.stringify({
        active: app.setting.activeTab?.id,
        rootCount: document.querySelectorAll(".ntfy-sync-settings").length
      })
    `);
    return state.active === "ntfy-sync" && state.rootCount === 1;
  }, "status keyboard settings navigation");
  checks.statusKeyboardOpensSettings = true;
  await evaluate(`
    (() => {
      const element = document.querySelector('[data-testid="ntfy-sync-status"]');
      const rect = element.getBoundingClientRect();
      for (const type of ["pointerenter", "pointerover", "mouseenter", "mouseover", "mousemove"]) {
        const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        element.dispatchEvent(new EventType(type, {
          bubbles: true,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
          view: window,
          pointerType: "mouse"
        }));
      }
      return "hovered";
    })()
  `);
  await waitFor(async () => {
    const count = await evaluateRead(
      `document.querySelectorAll(".tooltip.ntfy-sync-status-tooltip").length`,
    );
    return count === "1";
  }, "status tooltip after settings navigation");
  const tooltipTheme = await evaluateJson(`
    (() => {
      const body = document.body;
      const tooltip = document.querySelector(".tooltip.ntfy-sync-status-tooltip");
      const wasLight = body.classList.contains("theme-light");
      const wasDark = body.classList.contains("theme-dark");
      const read = () => {
        const style = getComputedStyle(tooltip);
        const arrow = getComputedStyle(tooltip.querySelector(".tooltip-arrow"));
        return { background: style.backgroundColor, color: style.color, arrow: arrow.borderTopColor };
      };
      body.classList.remove("theme-dark");
      body.classList.add("theme-light");
      const light = read();
      body.classList.remove("theme-light");
      body.classList.add("theme-dark");
      const dark = read();
      body.classList.toggle("theme-light", wasLight);
      body.classList.toggle("theme-dark", wasDark);
      return JSON.stringify({ light, dark });
    })()
  `);
  assert(
    tooltipTheme.light.background !== "rgba(0, 0, 0, 0.9)" &&
      tooltipTheme.dark.background !== "rgb(0, 0, 0)" &&
      tooltipTheme.light.background === tooltipTheme.light.arrow &&
      tooltipTheme.dark.background === tooltipTheme.dark.arrow,
    "status tooltip does not follow theme colors",
  );
  checks.themeAwareTooltip = true;

  await evaluate(`
    (() => {
      const element = document.querySelector('[data-testid="ntfy-sync-status"]');
      for (const type of ['pointerleave', 'pointerout', 'mouseleave', 'mouseout']) {
        const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        element?.dispatchEvent(new EventType(type, { bubbles: true, view: window, pointerType: 'mouse' }));
      }
      document.querySelectorAll('.tooltip.ntfy-sync-status-tooltip').forEach((tooltip) => tooltip.remove());
      return 'status-hover-ended';
    })()
  `);

  await click("ntfy-rule-add");
  const ruleModalLayout = await evaluateJson(`
    (() => {
      const conditions = document.querySelector('[data-testid="ntfy-rule-conditions"]');
      const addCondition = document.querySelector('[data-testid="ntfy-rule-add-condition"]');
      const ruleName = document.querySelector('[data-testid="ntfy-rule-name"]');
      const enabled = document.querySelector('[data-testid="ntfy-rule-enabled"]');
      const notePath = document.querySelector('[data-testid="ntfy-rule-note-path"]');
      const attachmentPath = document.querySelector('[data-testid="ntfy-rule-attachment-path"]');
      const notePathSearch = document.querySelector('[data-testid="ntfy-rule-note-path-search"]');
      const attachmentPathSearch = document.querySelector(
        '[data-testid="ntfy-rule-attachment-path-search"]'
      );
      const notePathClear = document.querySelector('[data-testid="ntfy-rule-note-path-clear"]');
      const attachmentPathClear = document.querySelector(
        '[data-testid="ntfy-rule-attachment-path-clear"]'
      );
      const conditionsInfo = conditions?.querySelector('.setting-item-info');
      const ruleNameInfo = ruleName?.closest('.setting-item')?.querySelector('.setting-item-info');
      const conditionRect = conditions?.getBoundingClientRect();
      const buttonRect = addCondition?.getBoundingClientRect();
      const sameRow = Boolean(
        conditionRect &&
        buttonRect &&
        buttonRect.top < conditionRect.bottom &&
        buttonRect.bottom > conditionRect.top
      );
      return JSON.stringify({
        buttonInConditionsRow: Boolean(addCondition && conditions?.contains(addCondition)),
        conditionsAligned: Boolean(
          conditionsInfo &&
          ruleNameInfo &&
          Math.abs(
            conditionsInfo.getBoundingClientRect().left - ruleNameInfo.getBoundingClientRect().left
          ) <= 0.5
        ),
        sameRow,
        usesHeadingLayout: conditions?.classList.contains('setting-item-heading') ?? true,
        addConditionCta: addCondition?.classList.contains('mod-cta') ?? false,
        enabledInRuleNameRow: Boolean(
          enabled &&
          ruleName?.closest('.setting-item') === enabled.closest('.setting-item') &&
          enabled.getBoundingClientRect().left > ruleName.getBoundingClientRect().right
        ),
        ruleNameWidth: ruleName?.getBoundingClientRect().width ?? 0,
        notePathWidth: notePathSearch?.getBoundingClientRect().width ?? 0,
        attachmentPathWidth: attachmentPathSearch?.getBoundingClientRect().width ?? 0,
        notePathTag: notePath?.tagName,
        attachmentPathTag: attachmentPath?.tagName,
        notePathSearchControls: Boolean(
          notePath && notePathClear && notePathSearch?.contains(notePath) && notePathSearch.contains(notePathClear)
        ),
        attachmentPathSearchControls: Boolean(
          attachmentPath &&
          attachmentPathClear &&
          attachmentPathSearch?.contains(attachmentPath) &&
          attachmentPathSearch.contains(attachmentPathClear)
        )
      });
    })()
  `);
  assert(
    ruleModalLayout.buttonInConditionsRow &&
      ruleModalLayout.conditionsAligned &&
      ruleModalLayout.sameRow &&
      !ruleModalLayout.usesHeadingLayout &&
      ruleModalLayout.addConditionCta,
    "Conditions heading and Add condition are not aligned in one setting row",
  );
  assert(
    ruleModalLayout.notePathTag === "INPUT" &&
      ruleModalLayout.attachmentPathTag === "INPUT" &&
      ruleModalLayout.notePathWidth > ruleModalLayout.ruleNameWidth &&
      ruleModalLayout.attachmentPathWidth > ruleModalLayout.ruleNameWidth &&
      ruleModalLayout.notePathSearchControls &&
      ruleModalLayout.attachmentPathSearchControls,
    "rule path fields are not widened single-line inputs",
  );
  assert(ruleModalLayout.enabledInRuleNameRow, "Enabled toggle is not right of Rule name input");
  await captureScreenshot(
    resolve(artifactDirectory, "rule-modal-layout.png"),
    "add-rule-modal",
    `ruleModal && !tooltip && modalTitle === ${JSON.stringify(ui.addTitle)} && visible(byId('ntfy-rule-add-condition')) && visible(byId('ntfy-rule-note-path'))`,
  );
  checks.conditionsHeadingAndAddShareRow = true;
  checks.addConditionUsesCtaStyle = true;
  checks.enabledToggleInRuleNameRow = true;
  checks.rulePathInputsSingleLineAndWide = true;
  checks.rulePathSearchAndClearControls = true;
  checks.ruleModalLayoutScreenshotCaptured = true;
  await click("ntfy-rule-note-path-clear");
  await waitFor(async () => {
    const cleared = await evaluateRead(
      `document.querySelector('[data-testid="ntfy-rule-note-path"]')?.value === ""`,
    );
    return cleared === "true";
  }, "note path clear control");
  checks.rulePathClearControlWorks = true;
  await evaluate(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-rule-note-path"]');
      if (!input) throw new Error("missing ntfy-rule-note-path");
      input.focus();
      input.value = ".md";
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: ".md" })
      );
      return "searching";
    })()
  `);
  await waitFor(async () => {
    const suggestionCount = await evaluateRead(
      `document.querySelectorAll(".suggestion-container .suggestion-item").length`,
    );
    return Number(suggestionCount) > 0;
  }, "note path Vault suggestions");
  await evaluate(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-rule-note-path"]');
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return "closed";
    })()
  `);
  checks.rulePathVaultSuggestions = true;

  await click("ntfy-rule-add-condition");
  const conditionMatrix = {
    topic: { operators: ["equals", "contains", "startsWith"], control: "INPUT" },
    title: { operators: ["equals", "contains", "startsWith"], control: "INPUT" },
    body: { operators: ["equals", "contains", "startsWith"], control: "INPUT" },
    tag: { operators: ["contains"], control: "INPUT" },
    priority: {
      operators: ["equals", "gte"],
      control: "SELECT",
      values: ["1", "2", "3", "4", "5"],
    },
    hasAttachment: { operators: ["equals"], control: "SELECT", values: ["true", "false"] },
    hasHttpUrl: { operators: ["equals"], control: "SELECT", values: ["true", "false"] },
    attachmentMime: { operators: ["equals", "startsWith"], control: "INPUT", search: true },
    firstUrlHost: { operators: ["hostEquals", "hostOrSubdomainOf"], control: "INPUT" },
  };
  const conditionFields = await evaluateJson(`
    (() => {
      const select = document.querySelector('[data-testid="ntfy-rule-condition-field-0"]');
      const options = [...select.options];
      return JSON.stringify({
        values: options.map((option) => option.value),
        tagLabel: options.find((option) => option.value === "tag")?.textContent
      });
    })()
  `);
  assert(
    JSON.stringify(conditionFields.values) === JSON.stringify(Object.keys(conditionMatrix)),
    "condition field dropdown does not expose the complete field set",
  );
  assert(conditionFields.tagLabel === ui.tagLabel, "tag condition label is ambiguous");
  checks.tagConditionLabelClarified = true;
  for (const [field, expected] of Object.entries(conditionMatrix)) {
    await setInput("ntfy-rule-condition-field-0", field, "change");
    const shape = await evaluateJson(`
      (() => {
        const operator = document.querySelector('[data-testid="ntfy-rule-condition-op-0"]');
        const value = document.querySelector('[data-testid="ntfy-rule-condition-value-0"]');
        return JSON.stringify({
          field: document.querySelector('[data-testid="ntfy-rule-condition-field-0"]')?.value,
          operators: [...operator.options].map((option) => option.value),
          control: value?.tagName,
          values: value?.tagName === "SELECT"
            ? [...value.options].map((option) => option.value)
            : undefined
        });
      })()
    `);
    assert(
      shape.field === field &&
        JSON.stringify(shape.operators) === JSON.stringify(expected.operators) &&
        shape.control === expected.control &&
        JSON.stringify(shape.values) === JSON.stringify(expected.values),
      `condition editor shape is incorrect for ${field}`,
    );
    if (field === "attachmentMime") {
      const searchShape = await evaluateJson(`
        (() => {
          const input = document.querySelector('[data-testid="ntfy-rule-condition-value-0"]');
          const container = document.querySelector('[data-testid="ntfy-rule-condition-mime-search-0"]');
          return JSON.stringify({
            placeholder: input?.getAttribute("placeholder"),
            ariaLabel: input?.getAttribute("aria-label"),
            inputInSearch: Boolean(input && container?.contains(input)),
            hasSearchIcon: Boolean(container?.querySelector(".search-input-clear-button") || container?.querySelector("svg")),
            hasClear: Boolean(document.querySelector('[data-testid="ntfy-rule-condition-mime-clear-0"]'))
          });
        })()
      `);
      assert(
        searchShape.placeholder === ui.mimePlaceholder &&
          searchShape.ariaLabel === ui.mimeAria &&
          searchShape.inputInSearch &&
          searchShape.hasSearchIcon &&
          searchShape.hasClear,
        "attachment MIME field is not an accessible SearchComponent with clear control",
      );
      await openMimeSuggestions(0);
      await waitFor(async () => {
        const values = await evaluateJson(`
          JSON.stringify([...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
            .map((item) => item.dataset.mimeValue))
        `);
        return values.includes("image/png") && values.includes("application/pdf");
      }, "common MIME presets");
      await openMimeSuggestions(0, "pdf");
      await waitFor(async () => {
        const values = await evaluateJson(`
          JSON.stringify([...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
            .map((item) => item.dataset.mimeValue))
        `);
        return values.length === 1 && values[0] === "application/pdf";
      }, "filtered MIME preset");
      await selectMimeSuggestion("application/pdf");
      const selectedMime = await evaluateRead(
        `document.querySelector('[data-testid="ntfy-rule-condition-value-0"]')?.value`,
      );
      assert(selectedMime === "application/pdf", "MIME preset selection did not update the input");
      await click("ntfy-rule-condition-mime-clear-0");
      const clearedMime = await evaluateRead(
        `document.querySelector('[data-testid="ntfy-rule-condition-value-0"]')?.value`,
      );
      assert(clearedMime === "", "MIME clear control did not clear the input");
      checks.mimeSearchAndClearControls = true;
      checks.mimeExactPresetsSelectable = true;
    }
    if (expected.operators.length > 1) {
      const selectedOperator = expected.operators.at(-1);
      await setInput("ntfy-rule-condition-op-0", selectedOperator, "change");
      const storedOperator = await evaluateRead(
        `document.querySelector('[data-testid="ntfy-rule-condition-op-0"]')?.value`,
      );
      assert(storedOperator === selectedOperator, `condition operator did not change for ${field}`);
    }
    if (field === "attachmentMime") {
      await openMimeSuggestions(0);
      await waitFor(async () => {
        const values = await evaluateJson(`
          JSON.stringify([...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
            .map((item) => item.dataset.mimeValue))
        `);
        return values.includes("image/");
      }, "MIME family presets");
      await selectMimeSuggestion("image/");
      const selectedFamily = await evaluateRead(
        `document.querySelector('[data-testid="ntfy-rule-condition-value-0"]')?.value`,
      );
      assert(selectedFamily === "image/", "MIME family preset did not update the input");
      checks.mimeFamilyPresetsSelectable = true;
    }
  }
  checks.conditionFieldOperatorMatrix = true;
  await click("ntfy-rule-condition-delete-0");
  await waitFor(async () => {
    const deletedCondition = await evaluateJson(`
      JSON.stringify({
        count: document.querySelectorAll(".ntfy-sync-rule-condition").length,
        description: document.querySelector('[data-testid="ntfy-rule-conditions"] .setting-item-description')?.textContent ?? ""
      })
    `);
    return deletedCondition.count === 0 && deletedCondition.description.includes(ui.noConditions);
  }, "condition delete restoring the all-message state");
  checks.conditionDeleteRestoresMatchAll = true;

  await setInput("ntfy-rule-name", "");
  await click("ntfy-rule-save");
  await waitFor(async () => {
    const state = await evaluateJson(`
      JSON.stringify({
        validation: document.querySelector('[data-testid="ntfy-rule-validation"]')?.textContent ?? "",
        count: app.plugins.getPlugin("ntfy-sync").settings.rules.rules.length
      })
    `);
    return state.validation.includes(ui.nameRequired) && state.count === baselineCount;
  }, "invalid draft rejection");
  checks.invalidDraftRejected = true;
  await click("ntfy-rule-cancel");

  await click("ntfy-rule-add");
  await click("ntfy-rule-add-condition");
  await setInput("ntfy-rule-name", draftName);
  await setInput("ntfy-rule-condition-field-0", "firstUrlHost", "change");
  await setInput("ntfy-rule-condition-op-0", "hostEquals", "change");
  await setInput("ntfy-rule-condition-value-0", "example.invalid");
  await click("ntfy-rule-add-condition");
  await setInput("ntfy-rule-condition-field-1", "priority", "change");
  await setInput("ntfy-rule-condition-op-1", "gte", "change");
  await setInput("ntfy-rule-condition-value-1", "4", "change");
  await click("ntfy-rule-add-condition");
  await setInput("ntfy-rule-condition-field-2", "hasAttachment", "change");
  await setInput("ntfy-rule-condition-value-2", "false", "change");
  await click("ntfy-rule-add-condition");
  await setInput("ntfy-rule-condition-field-3", "attachmentMime", "change");
  await setInput("ntfy-rule-condition-op-3", "startsWith", "change");
  await openMimeSuggestions(3);
  await waitFor(async () => {
    const available = await evaluateRead(
      `[...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')].some((item) => item.dataset.mimeValue === "image/")`,
    );
    return available === "true";
  }, "persisted MIME family preset");
  await selectMimeSuggestion("image/");
  await click("ntfy-rule-save");
  await waitFor(async () => {
    const state = await evaluateJson(`
      (() => {
        const plugin = app.plugins.getPlugin("ntfy-sync");
        const rule = plugin.settings.rules.rules.at(-1);
        return JSON.stringify({ count: plugin.settings.rules.rules.length, name: rule?.name });
      })()
    `);
    return state.count === baselineCount + 1 && state.name === draftName;
  }, "rule add persistence");
  let state = await evaluateJson(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      const rule = plugin.settings.rules.rules.at(-1);
      return JSON.stringify({
        revision: rule?.revision,
        conditions: rule?.when.all,
        cardCount: document.querySelectorAll(".ntfy-sync-rule-card").length
      });
    })()
  `);
  assert(state.revision === 1, "new rule revision is not 1");
  assert(
    JSON.stringify(state.conditions) ===
      JSON.stringify([
        { field: "firstUrlHost", op: "hostEquals", value: "example.invalid" },
        { field: "priority", op: "gte", value: 4 },
        { field: "hasAttachment", op: "equals", value: false },
        { field: "attachmentMime", op: "startsWith", value: "image/" },
      ]),
    `multi-type conditions were not saved: ${JSON.stringify(state.conditions)}`,
  );
  assert(state.cardCount === baselineCount + 1, "new card not rendered");
  checks.addedStructuredRule = true;
  checks.multiTypeConditionsPersisted = true;

  await click(`ntfy-rule-up-${baselineCount}`);
  await waitFor(async () => {
    const order = await evaluateJson(`
      (() => {
        const rules = app.plugins.getPlugin("ntfy-sync").settings.rules.rules;
        return JSON.stringify({ moved: rules[${baselineCount - 1}]?.name });
      })()
    `);
    return order.moved === draftName;
  }, "rule reorder persistence");
  checks.reordered = true;

  await obsidian("plugin:reload", "id=ntfy-sync");
  await openSettings();
  const reloadedConditions = await evaluateJson(`
    (() => {
      const rule = app.plugins.getPlugin("ntfy-sync").settings.rules.rules[${baselineCount - 1}];
      return JSON.stringify({ name: rule?.name, conditions: rule?.when.all });
    })()
  `);
  assert(
    reloadedConditions.name === draftName &&
      JSON.stringify(reloadedConditions.conditions) === JSON.stringify(state.conditions),
    "saved conditions did not survive plugin reload",
  );
  checks.conditionReloadPersistence = true;

  await click(`ntfy-rule-edit-${baselineCount - 1}`);
  const editModalTitle = await evaluateRead(
    `document.querySelector('[data-testid="ntfy-rule-modal"] .modal-title')?.textContent`,
  );
  assert(editModalTitle === ui.editTitle, "edit rule modal title is incorrect");
  await captureScreenshot(
    resolve(artifactDirectory, "edit-rule-modal-layout.png"),
    "edit-rule-modal",
    `ruleModal && !tooltip && modalTitle === ${JSON.stringify(ui.editTitle)} && byId('ntfy-rule-name')?.value === ${JSON.stringify(draftName)}`,
  );
  checks.editRuleModalLayoutScreenshotCaptured = true;
  await setInput("ntfy-rule-name", editedName);
  await click("ntfy-rule-save");
  await waitFor(async () => {
    const edited = await evaluateJson(`
      (() => {
        const rule = app.plugins.getPlugin("ntfy-sync").settings.rules.rules[${baselineCount - 1}];
        return JSON.stringify({ name: rule?.name, revision: rule?.revision });
      })()
    `);
    return edited.name === editedName && edited.revision === 2;
  }, "rule edit persistence");
  checks.editedAndRevisioned = true;

  await click(`ntfy-rule-delete-${baselineCount - 1}`);
  state = await evaluateJson(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      const button = document.querySelector('[data-testid="ntfy-rule-delete-${baselineCount - 1}"]');
      return JSON.stringify({ count: plugin.settings.rules.rules.length, confirming: button?.dataset.confirming });
    })()
  `);
  assert(
    state.count === baselineCount + 1 && state.confirming === "true",
    "delete did not require confirmation",
  );
  await click(`ntfy-rule-delete-${baselineCount - 1}`);
  await waitFor(async () => {
    const cleaned = await evaluateJson(`
      (() => {
        const rules = app.plugins.getPlugin("ntfy-sync").settings.rules.rules;
        return JSON.stringify({
          count: rules.length,
          testRules: rules.filter((rule) => rule.name.startsWith("UI acceptance ")).length,
          cards: document.querySelectorAll(".ntfy-sync-rule-card").length
        });
      })()
    `);
    return (
      cleaned.count === baselineCount && cleaned.testRules === 0 && cleaned.cards === baselineCount
    );
  }, "confirmed delete persistence");
  checks.confirmedDelete = true;

  await obsidian("plugin:reload", "id=ntfy-sync");
  const reloaded = await openSettings();
  assert(
    reloaded.ruleCount === baselineCount && reloaded.cardCount === baselineCount,
    "reload changed rule state",
  );
  checks.reloadPersistence = true;

  const screenshotPath = resolve(artifactDirectory, "rules-settings.png");
  await evaluate(`
    (() => {
      const root = document.querySelector('.ntfy-sync-settings');
      const applySetting = document.querySelector('[data-testid="ntfy-apply-setting"]')?.closest('.setting-item');
      applySetting?.scrollIntoView({ block: 'end' });
      return "final-rules-scrolled";
    })()
  `);
  await captureScreenshot(
    screenshotPath,
    "final-rules-settings",
    `root && !ruleModal && !tooltip && applySetting && (scroll?.scrollTop ?? 0) > 1 && document.querySelectorAll('.ntfy-sync-rule-card').length === ${baselineCount}`,
  );
  checks.screenshotCaptured = true;

  const errors = await obsidian("dev:errors");
  assert(errors.includes("No errors captured."), "Obsidian captured a UI acceptance error");
  if (!documentScreenshots) {
    const consoleErrors = await obsidian("dev:console", "level=error");
    assert(
      consoleErrors.includes("No console messages captured."),
      "Console captured a UI acceptance error",
    );
  }
  checks.noNewErrors = true;
} finally {
  if (vaultName) {
    try {
      await evaluate(
        `document.querySelectorAll('[data-testid="ntfy-rule-cancel"]').forEach((button) => button.click()); document.querySelectorAll('.tooltip.ntfy-sync-status-tooltip').forEach((tooltip) => tooltip.remove()); "closed"`,
      );
    } catch {
      // The modal is normally already closed.
    }
  }
  if (originalData && dataPath) {
    await writeFile(dataPath, originalData, { mode: 0o600 });
    if (backupPath) {
      await removeFileIfPresent(backupPath);
    }
  }
  if (vaultName && originalData) {
    try {
      await obsidian("plugin:reload", "id=ntfy-sync");
      await evaluate(
        `document.querySelectorAll('[data-testid="ntfy-rule-cancel"]').forEach((button) => button.click()); "closed"`,
      );
    } catch {
      // Preserve the original data even if the app closes during cleanup.
    }
  }
  if (viewportEvidence && vaultName) {
    try {
      viewportEvidence.restoration = await restoreViewport({ cdp, evaluateJson }, viewportEvidence);
      checks.viewportOverrideCleared = viewportEvidence.restoration.cleared;
    } catch {
      checks.viewportOverrideCleared = false;
    }
  }
  if (debugAttached) {
    try {
      await evaluate(`document.getElementById("ntfy-ui-review-privacy-mask")?.remove(); "removed"`);
      await obsidian("dev:debug", "off");
    } catch {
      // The app may already be closed.
    }
  }
}

const restoredData = await readFile(dataPath);
checks.originalSettingsRestored = restoredData.equals(originalData);
assert(checks.originalSettingsRestored, "Original test Vault settings were not restored");
assert(checks.viewportOverrideCleared, "Obsidian viewport override was not cleared");

const report = {
  schema: "obsidian.ntfy-sync.ui-acceptance.v1",
  runId,
  generatedAt: new Date().toISOString(),
  vault: vaultName,
  pluginId: "ntfy-sync",
  pluginLanguage,
  hostLanguage: observedHostLanguage,
  viewport: viewportEvidence,
  screenshots: screenshotEvidence,
  checks,
  passed: Object.values(checks).every((value) => value === true || typeof value === "number"),
};
await writeFile(join(artifactDirectory, "report.json"), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.passed) process.exitCode = 1;
