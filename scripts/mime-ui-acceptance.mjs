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
  process.env.NTFY_UI_RUN_ID ?? `mime-ui-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const reviewScreenshots = process.env.NTFY_UI_REVIEW_SCREENSHOTS === "1";
const pluginLanguage = process.env.NTFY_UI_PLUGIN_LANGUAGE ?? "en";
assertSupportedLanguage(pluginLanguage);
const expectedHostLanguage = process.env.NTFY_UI_EXPECTED_OBSIDIAN_LANGUAGE;
const ui =
  pluginLanguage === "zh-CN"
    ? {
        addTitle: "添加消息分发规则",
        topicsDescription: "使用英文逗号分隔；诊断信息会隐藏具体值。",
        mimePlaceholder: "搜索或输入 MIME 类型",
        mimeAria: "附件 MIME 类型",
        reviewRuleName: "示例 MIME 规则",
      }
    : {
        addTitle: "Add message distribution rule",
        topicsDescription: "Comma-separated. Values are redacted from diagnostics.",
        mimePlaceholder: "Search or enter a MIME type",
        mimeAria: "Attachment MIME type",
        reviewRuleName: "Example MIME rule",
      };
const acceptanceResultTopic = `ui-result-${randomBytes(4).toString("hex")}`;
const artifactRoot = process.env.NTFY_UI_ARTIFACT_ROOT ?? join(".artifacts", "ui-automation");
const artifactDirectory = join(artifactRoot, runId);
await mkdir(artifactDirectory, { recursive: true });

const checks = {};
const screenshotEvidence = {};
let vaultName;
let dataPath;
let backupPath;
let originalData;
let debugAttached = false;
let viewportEvidence;
let observedHostLanguage;
let originalPluginEnabled;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSupportedLanguage(value) {
  if (value !== "en" && value !== "zh-CN") {
    throw new Error(`Unsupported NTFY_UI_PLUGIN_LANGUAGE: ${value}`);
  }
}

function progress(step) {
  process.stdout.write(`${JSON.stringify({ runId, step })}\n`);
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
  const scopedCode = `
    (() => {
      const document =
        activeDocument?.visibilityState === "visible" ||
        activeDocument?.querySelector('[data-testid="ntfy-rule-modal"]')
          ? activeDocument
          : app.workspace.containerEl.ownerDocument;
      const window = document.defaultView;
      const innerWidth = window.innerWidth;
      const innerHeight = window.innerHeight;
      const devicePixelRatio = window.devicePixelRatio;
      const matchMedia = window.matchMedia.bind(window);
      const getComputedStyle = window.getComputedStyle.bind(window);
      const Event = window.Event;
      const KeyboardEvent = window.KeyboardEvent;
      const MouseEvent = window.MouseEvent;
      const PointerEvent = window.PointerEvent;
      return eval(${JSON.stringify(code)});
    })()
  `;
  const output = await obsidian("eval", `code=${scopedCode}`);
  const line = output.split(/\r?\n/u).findLast((candidate) => candidate.startsWith("=> "));
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const output = await evaluateRead(code);
    if (output) return JSON.parse(output);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Obsidian eval returned no JSON result");
}

async function cdp(method, params) {
  return obsidian("dev:cdp", `method=${method}`, `params=${JSON.stringify(params)}`);
}

async function captureActiveRenderer(method, params) {
  if (method !== "Page.captureScreenshot") return cdp(method, params);
  const activeRendererIsMain =
    (await evaluateRead(`document === app.workspace.containerEl.ownerDocument`)) === "true";
  if (activeRendererIsMain) return cdp(method, params);
  return evaluate(`
    (async () => {
      const remote = require("@electron/remote");
      const title = document.title;
      const expectsSettings = Boolean(document.querySelector(".ntfy-sync-settings"));
      const candidates = remote.BrowserWindow.getAllWindows()
        .filter((candidate) => candidate.getTitle() === title && candidate.isVisible());
      let target;
      for (const candidate of candidates) {
        const hasSettings = await candidate.webContents.executeJavaScript(
          'Boolean(document.querySelector(".ntfy-sync-settings"))'
        );
        if (hasSettings === expectsSettings) {
          target = candidate;
          break;
        }
      }
      if (!target) throw new Error("Active Electron renderer was not found");
      const image = await target.webContents.capturePage();
      return JSON.stringify({ data: image.toPNG().toString("base64") });
    })()
  `);
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
    cdp: captureActiveRenderer,
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
      const geometry = [...document.querySelectorAll('.ntfy-sync-settings [data-testid], [data-testid="ntfy-rule-modal"] [data-testid], .ntfy-sync-mime-suggestion-container')]
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
        suggestionPlacement: suggestion?.dataset.placement ?? '',
        suggestions: visibleSuggestions.map((item) => item.dataset.mimeValue),
        text: ruleModal?.innerText ?? root?.innerText ?? '',
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
          modalTitle,
          suggestionPlacement: suggestion?.dataset.placement ?? '',
          suggestionCount: visibleSuggestions.length,
          mimeOperator: byId('ntfy-rule-condition-op-0')?.value ?? '',
          mimeValue: byId('ntfy-rule-condition-value-0')?.value ?? ''
        }
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

async function openMimeSuggestions(query = "") {
  await evaluateRead(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-rule-condition-value-0"]');
      if (!input) throw new Error("missing MIME search input");
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

async function mimeSuggestionValues() {
  return evaluateJson(`
    JSON.stringify([...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
      .filter((item) => item.getClientRects().length > 0)
      .map((item) => item.dataset.mimeValue))
  `);
}

async function selectMimeSuggestion(value) {
  await evaluate(`
    (() => {
      const item = [...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
        .find((candidate) =>
          candidate.getClientRects().length > 0 &&
          candidate.dataset.mimeValue === ${JSON.stringify(value)}
        );
      if (!item) throw new Error("missing MIME suggestion ${value}");
      item.click();
      return "selected";
    })()
  `);
}

async function openSettings() {
  await evaluate(`
    app.setting.open();
    app.setting.openTabById("ntfy-sync");
    "settings-opened";
  `);
  await waitForStableLayout(evaluateJson, ".ntfy-sync-settings");
  return evaluateJson(`
    (() => {
      return JSON.stringify({
        active: app.setting.activeTab?.id,
        addCount: document.querySelectorAll('[data-testid="ntfy-rule-add"]').length
      });
    })()
  `);
}

try {
  const installation = await installTestVault();
  vaultName = installation.vaultName;
  assert(/test/iu.test(basename(installation.vault)), "MIME UI acceptance requires a test Vault");
  dataPath = resolve(installation.destination, "data.json");
  backupPath = resolve(installation.destination, "data.ui-acceptance-backup.json");

  try {
    const strandedBackup = await readFile(backupPath);
    await writeFile(dataPath, strandedBackup, { mode: 0o600 });
    await removeFileIfPresent(backupPath);
    checks.strandedBackupRecovered = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    checks.strandedBackupRecovered = true;
  }

  originalData = await readFile(dataPath);
  await writeFile(backupPath, originalData, { mode: 0o600 });
  const baseline = JSON.parse(originalData.toString("utf8"));
  const baselineCount = baseline.rules.rules.length;
  const acceptanceSettings = structuredClone(baseline);
  acceptanceSettings.enabled = false;
  acceptanceSettings.uiLanguage = pluginLanguage;
  for (const connection of acceptanceSettings.connections) {
    connection.readAuth = { kind: "none" };
    connection.result = {
      topic: acceptanceResultTopic,
      writeAuth: { kind: "none" },
      privacy: "minimal",
      cache: true,
    };
    if (reviewScreenshots) {
      connection.baseUrl = "https://ntfy.sh";
      connection.topics = ["example-topic"];
    }
  }
  if (reviewScreenshots) {
    acceptanceSettings.rules.rules.forEach((rule, index) => {
      rule.name =
        pluginLanguage === "zh-CN" ? `示例规则 ${index + 1}` : `Example rule ${index + 1}`;
      rule.action.notePathTemplate =
        pluginLanguage === "zh-CN" ? `示例/规则-${index + 1}.md` : `Examples/rule-${index + 1}.md`;
      rule.action.attachmentPathTemplate =
        pluginLanguage === "zh-CN"
          ? `示例/附件/规则-${index + 1}`
          : `Examples/attachments/rule-${index + 1}`;
      for (const condition of rule.when.all) {
        if (typeof condition.value === "string") condition.value = "example.invalid";
      }
    });
  }
  await writeFile(dataPath, `${JSON.stringify(acceptanceSettings, null, 2)}\n`, { mode: 0o600 });
  checks.acceptanceCredentialsSanitized = true;
  progress("settings-snapshotted");

  try {
    await obsidian("dev:debug", "off");
  } catch {
    // A fresh renderer session may not have a debugger attached.
  }
  originalPluginEnabled =
    (await evaluateRead(`app.plugins.enabledPlugins.has("ntfy-sync")`)) === "true";
  await evaluate(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      app.setting.close();
      const mainWindow =
        plugin?.statusElement?.ownerDocument.defaultView ??
        app.workspace.containerEl.ownerDocument.defaultView;
      mainWindow.focus();
      return "main-window-focused";
    })()
  `);
  await obsidian("dev:debug", "on");
  debugAttached = true;
  checks.debuggerAttached = true;
  if (originalPluginEnabled) await obsidian("plugin:reload", "id=ntfy-sync");
  else await obsidian("plugin:enable", "id=ntfy-sync");
  await evaluate(`
    (() => {
      document.getElementById("ntfy-ui-review-privacy-mask")?.remove();
      if (${JSON.stringify(reviewScreenshots)}) {
        const style = document.createElement("style");
        style.id = "ntfy-ui-review-privacy-mask";
        style.textContent =
          ".workspace, .notice-container { visibility: hidden !important; }";
        document.head.append(style);
      }
      document.querySelectorAll('.tooltip.ntfy-sync-status-tooltip').forEach((tooltip) => tooltip.remove());
      return "review-privacy-mask-ready";
    })()
  `);
  progress("plugin-reloaded");

  viewportEvidence = await normalizeDesktopViewport({ cdp, evaluateJson });
  checks.desktopViewportNormalized = true;
  checks.desktopViewportWidth = viewportEvidence.normalized.innerWidth;
  checks.desktopViewportHeight = viewportEvidence.normalized.innerHeight;
  checks.rootFontPx = viewportEvidence.normalized.rootFontPx;
  if (viewportEvidence.simulatedInitial) {
    checks.initialViewportWasNarrow = viewportEvidence.before.narrow;
  }
  progress("desktop-viewport-normalized");

  await evaluate(`
    (() => {
      document.querySelectorAll('[data-testid="ntfy-rule-cancel"]').forEach((button) => button.click());
      return "stale-modals-closed";
    })()
  `);

  const settings = await openSettings();
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
  checks.targetPluginLanguageApplied = true;
  assert(settings.active === "ntfy-sync" && settings.addCount === 1, "settings did not open");
  const compactControlLayout = await evaluateJson(`
    (() => {
      const inspect = (testId) => {
        const element = document.querySelector('[data-testid="' + testId + '"]');
        const setting = element?.closest(".setting-item");
        return {
          controlWidth: setting?.querySelector(".setting-item-control")?.getBoundingClientRect().width ?? 0,
          elementWidth: element?.getBoundingClientRect().width ?? 0,
          compactClass: setting?.classList.contains("ntfy-sync-control-14rem") ?? false
        };
      };
      const topics = inspect("ntfy-topics");
      const topicsSetting = document.querySelector('[data-testid="ntfy-topics"]')?.closest(".setting-item");
      return JSON.stringify({
        rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        serverUrl: inspect("ntfy-server-url"),
        topics,
        publishResult: inspect("ntfy-publish-result"),
        resultTopic: inspect("ntfy-result-topic"),
        topicsDescription: topicsSetting?.querySelector(".setting-item-description")?.textContent?.trim() ?? "",
        topicsClass: topicsSetting?.classList.contains("ntfy-sync-topics-setting") ?? false
      });
    })()
  `);
  const is14Rem = (width) => Math.abs(width - compactControlLayout.rootFontPx * 14) <= 0.5;
  assert(
    is14Rem(compactControlLayout.serverUrl.controlWidth) &&
      is14Rem(compactControlLayout.serverUrl.elementWidth) &&
      is14Rem(compactControlLayout.topics.controlWidth) &&
      is14Rem(compactControlLayout.topics.elementWidth) &&
      is14Rem(compactControlLayout.publishResult.controlWidth) &&
      is14Rem(compactControlLayout.resultTopic.controlWidth) &&
      is14Rem(compactControlLayout.resultTopic.elementWidth) &&
      compactControlLayout.serverUrl.compactClass &&
      compactControlLayout.topics.compactClass &&
      compactControlLayout.publishResult.compactClass &&
      compactControlLayout.resultTopic.compactClass &&
      compactControlLayout.topicsDescription === ui.topicsDescription &&
      !compactControlLayout.topicsDescription.includes("1-64") &&
      compactControlLayout.topicsClass,
    `Compact control layout is incorrect: ${JSON.stringify(compactControlLayout)}`,
  );
  checks.primaryConnectionControlsUse14Rem = true;
  checks.topicsPolicyDescriptionRemainsConcise = true;
  progress("primary-controls-14rem-verified");
  const topicConflict = await evaluateJson(`
    (() => {
      const plugin = app.plugins.getPlugin("ntfy-sync");
      const input = document.querySelector('[data-testid="ntfy-topics"]');
      const before = JSON.stringify(plugin.settings.connections[0].topics);
      input.value = ${JSON.stringify(acceptanceResultTopic)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const rejected = {
        unchanged: JSON.stringify(plugin.settings.connections[0].topics) === before,
        topicsError: Boolean(document.querySelector('[data-testid="ntfy-topics-validation"]')),
        resultError: Boolean(document.querySelector('[data-testid="ntfy-result-topic-validation"]'))
      };
      input.value = JSON.parse(before).join(", ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return JSON.stringify({
        ...rejected,
        restored: JSON.stringify(plugin.settings.connections[0].topics) === before,
        topicsErrorCleared: !document.querySelector('[data-testid="ntfy-topics-validation"]'),
        resultErrorCleared: !document.querySelector('[data-testid="ntfy-result-topic-validation"]')
      });
    })()
  `);
  assert(
    topicConflict.unchanged &&
      topicConflict.topicsError &&
      topicConflict.resultError &&
      topicConflict.restored &&
      topicConflict.topicsErrorCleared &&
      topicConflict.resultErrorCleared,
    `Topic/result conflict validation is incorrect: ${JSON.stringify(topicConflict)}`,
  );
  checks.topicResultConflictRejectedAndRefreshed = true;
  await click("ntfy-rule-add");
  await waitFor(async () => {
    const modalCount = await evaluateRead(
      `document.querySelectorAll('[data-testid="ntfy-rule-modal"]').length`,
    );
    return modalCount === "1";
  }, "one MIME rule modal");
  await click("ntfy-rule-add-condition");
  const initialConditionCount = await evaluateRead(
    `document.querySelectorAll('[data-testid="ntfy-rule-modal"] .ntfy-sync-rule-condition').length`,
  );
  assert(initialConditionCount === "1", "MIME rule draft did not start with exactly one condition");
  await setInput(
    "ntfy-rule-name",
    reviewScreenshots ? ui.reviewRuleName : `MIME acceptance ${randomBytes(4).toString("hex")}`,
  );
  await setInput("ntfy-rule-condition-field-0", "attachmentMime", "change");

  const searchShape = await evaluateJson(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-rule-condition-value-0"]');
      const container = document.querySelector('[data-testid="ntfy-rule-condition-mime-search-0"]');
      const clear = document.querySelector('[data-testid="ntfy-rule-condition-mime-clear-0"]');
      const remove = document.querySelector('[data-testid="ntfy-rule-condition-delete-0"]');
      const notePath = document.querySelector('[data-testid="ntfy-rule-note-path-search"]');
      const attachmentPath = document.querySelector('[data-testid="ntfy-rule-attachment-path-search"]');
      const noteDescription = notePath?.closest(".setting-item")?.querySelector(".setting-item-description");
      const attachmentDescription = attachmentPath?.closest(".setting-item")?.querySelector(".setting-item-description");
      const lineCount = (element) => {
        if (!element) return 0;
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      };
      const containerRect = container?.getBoundingClientRect();
      const removeRect = remove?.getBoundingClientRect();
      const notePathRect = notePath?.getBoundingClientRect();
      const attachmentPathRect = attachmentPath?.getBoundingClientRect();
      const descriptionMaxLines = innerWidth < 1200 ? 3 : 1;
      const fitsWidth = (element) => Boolean(element && element.scrollWidth <= element.clientWidth + 1);
      return JSON.stringify({
        rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        tag: input?.tagName,
        placeholder: input?.getAttribute("placeholder"),
        ariaLabel: input?.getAttribute("aria-label"),
        nativeSearchContainer: container?.classList.contains("search-input-container") ?? false,
        inputInContainer: Boolean(input && container?.contains(input)),
        nativeClearControl: clear?.classList.contains("search-input-clear-button") ?? false,
        clearInContainer: Boolean(clear && container?.contains(clear)),
        clearAfterInput: Boolean(input && clear && input.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING),
        compactWidth: containerRect?.width ?? 0,
        notePathWidth: notePathRect?.width ?? 0,
        attachmentPathWidth: attachmentPathRect?.width ?? 0,
        noteDescriptionLines: lineCount(noteDescription),
        attachmentDescriptionLines: lineCount(attachmentDescription),
        descriptionMaxLines,
        noteDescriptionFits: fitsWidth(noteDescription),
        attachmentDescriptionFits: fitsWidth(attachmentDescription),
        pathWidthsMatch: Boolean(
          notePathRect && attachmentPathRect && Math.abs(notePathRect.width - attachmentPathRect.width) <= 1
        ),
        deleteSharesRow: Boolean(
          containerRect && removeRect && containerRect.top < removeRect.bottom && containerRect.bottom > removeRect.top
        )
      });
    })()
  `);
  const isRemWidth = (width, rem) => Math.abs(width - searchShape.rootFontPx * rem) <= 0.5;
  assert(
    searchShape.tag === "INPUT" &&
      searchShape.placeholder === ui.mimePlaceholder &&
      searchShape.ariaLabel === ui.mimeAria &&
      searchShape.nativeSearchContainer &&
      searchShape.inputInContainer &&
      searchShape.nativeClearControl &&
      searchShape.clearInContainer &&
      searchShape.clearAfterInput &&
      isRemWidth(searchShape.compactWidth, 18) &&
      isRemWidth(searchShape.notePathWidth, 26) &&
      isRemWidth(searchShape.attachmentPathWidth, 26) &&
      searchShape.pathWidthsMatch &&
      searchShape.noteDescriptionLines >= 1 &&
      searchShape.noteDescriptionLines <= searchShape.descriptionMaxLines &&
      searchShape.attachmentDescriptionLines >= 1 &&
      searchShape.attachmentDescriptionLines <= searchShape.descriptionMaxLines &&
      searchShape.noteDescriptionFits &&
      searchShape.attachmentDescriptionFits &&
      searchShape.deleteSharesRow,
    `invalid MIME search shape: ${JSON.stringify(searchShape)}`,
  );
  checks.nativeSearchWithLeftIcon = true;
  checks.rightClearControl = true;
  checks.accessibleMimeLabel = true;
  checks.compactMimeInputKeepsDeleteOnRow = true;
  checks.pathSearchInputsAreWideAndConsistent = true;
  checks.pathDescriptionsFitViewport = true;
  progress("search-structure-verified");
  if (reviewScreenshots) {
    await captureScreenshot(
      resolve(artifactDirectory, "mime-rule-editor.png"),
      "mime-rule-editor",
      `ruleModal && !tooltip && modalTitle === ${JSON.stringify(ui.addTitle)} && byId('ntfy-rule-condition-field-0')?.value === 'attachmentMime' && visibleSuggestions.length === 0 && byId('ntfy-rule-condition-value-0')?.value === ''`,
    );
  }

  await openMimeSuggestions();
  await waitFor(async () => {
    const values = await mimeSuggestionValues();
    return values.includes("image/png") && values.includes("application/pdf");
  }, "common exact MIME presets");
  checks.commonExactPresetsVisible = true;
  const presetLayout = await evaluateJson(`
    (() => {
      const item = [...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
        .find((candidate) =>
          candidate.getClientRects().length > 0 && candidate.dataset.mimeValue === "image/jpeg"
        );
      const label = item?.querySelector(".ntfy-sync-mime-suggestion-label");
      const value = item?.querySelector(".ntfy-sync-mime-suggestion-value");
      const popover = item?.closest(".ntfy-sync-mime-suggestion-container");
      const search = document.querySelector('[data-testid="ntfy-rule-condition-mime-search-0"]');
      const modal = document.querySelector('[data-testid="ntfy-rule-modal"]');
      const labelRect = label?.getBoundingClientRect();
      const valueRect = value?.getBoundingClientRect();
      const popoverRect = popover?.getBoundingClientRect();
      const searchRect = search?.getBoundingClientRect();
      const modalRect = modal?.getBoundingClientRect();
      return JSON.stringify({
        rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        display: item ? getComputedStyle(item).display : "",
        sameRow: Boolean(
          labelRect && valueRect && labelRect.top < valueRect.bottom && labelRect.bottom > valueRect.top
        ),
        nameBeforeValue: Boolean(labelRect && valueRect && labelRect.left < valueRect.left),
        valueTextAlign: value ? getComputedStyle(value).textAlign : "",
        valueTitle: value?.getAttribute("title"),
        dropdownMatchesSearch: Boolean(
          popoverRect && searchRect && Math.abs(popoverRect.width - searchRect.width) <= 1
        ),
        dropdownInsideModal: Boolean(
          popoverRect && modalRect &&
          popoverRect.left >= modalRect.left - 1 &&
          popoverRect.right <= modalRect.right + 1 &&
          popoverRect.top >= modalRect.top - 1 &&
          popoverRect.bottom <= modalRect.bottom + 1
        ),
        leftGap: popoverRect && labelRect ? labelRect.left - popoverRect.left : -1,
        rightGap: popoverRect && valueRect ? popoverRect.right - valueRect.right : -1
      });
    })()
  `);
  assert(
    presetLayout.display === "grid" &&
      presetLayout.sameRow &&
      presetLayout.nameBeforeValue &&
      presetLayout.valueTextAlign === "right" &&
      presetLayout.valueTitle === "image/jpeg" &&
      presetLayout.dropdownMatchesSearch &&
      presetLayout.dropdownInsideModal &&
      Math.abs(presetLayout.leftGap - presetLayout.rightGap) <= presetLayout.rootFontPx * 0.5,
    `MIME preset is not a left-name/right-value row: ${JSON.stringify(presetLayout)}`,
  );
  checks.mimePresetSingleLine = true;
  checks.mimeDropdownMatchesInputAndStaysInModal = true;
  checks.mimeDropdownHorizontalSpacingBalanced = true;
  if (reviewScreenshots) {
    await captureScreenshot(
      resolve(artifactDirectory, "mime-suggestions-below.png"),
      "mime-suggestions-below",
      `ruleModal && !tooltip && suggestion?.dataset.placement === 'below' && visibleSuggestions.length > 1 && visible(byId('ntfy-rule-condition-value-0'))`,
    );
  }

  await evaluate(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-rule-condition-value-0"]');
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const condition = document.querySelector('[data-testid="ntfy-rule-condition-0"]');
      const search = document.querySelector('[data-testid="ntfy-rule-condition-mime-search-0"]');
      const modal = document.querySelector('[data-testid="ntfy-rule-modal"]');
      if (!condition || !search || !modal) throw new Error("missing MIME placement fixture");
      const searchRect = search.getBoundingClientRect();
      const modalRect = modal.getBoundingClientRect();
      condition.style.transform = \`translateY(\${modalRect.bottom - searchRect.bottom - 4}px)\`;
      return "moved-near-modal-bottom";
    })()
  `);
  await openMimeSuggestions();
  await waitFor(async () => {
    const placement = await evaluateRead(
      `document.querySelector('.ntfy-sync-mime-suggestion-container')?.dataset.placement`,
    );
    return placement === "above";
  }, "MIME presets opening above near the modal bottom");
  const abovePlacement = await evaluateJson(`
    (() => {
      const popover = document.querySelector('.ntfy-sync-mime-suggestion-container');
      const search = document.querySelector('[data-testid="ntfy-rule-condition-mime-search-0"]');
      const modal = document.querySelector('[data-testid="ntfy-rule-modal"]');
      const visibleItems = [...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
        .filter((item) => item.getClientRects().length > 0);
      const popoverRect = popover?.getBoundingClientRect();
      const searchRect = search?.getBoundingClientRect();
      const modalRect = modal?.getBoundingClientRect();
      return JSON.stringify({
        placement: popover?.dataset.placement,
        insideModal: Boolean(
          popoverRect && modalRect &&
          popoverRect.top >= modalRect.top - 1 &&
          popoverRect.bottom <= modalRect.bottom + 1
        ),
        aboveInput: Boolean(popoverRect && searchRect && popoverRect.bottom <= searchRect.top + 1),
        usableHeight: popoverRect?.height ?? 0,
        visibleItemCount: visibleItems.length
      });
    })()
  `);
  assert(
    abovePlacement.placement === "above" &&
      abovePlacement.insideModal &&
      abovePlacement.aboveInput &&
      abovePlacement.usableHeight > 40 &&
      abovePlacement.visibleItemCount > 0,
    `MIME preset list did not use the available space above: ${JSON.stringify(abovePlacement)}`,
  );
  checks.mimeDropdownOpensAboveNearModalBottom = true;
  if (reviewScreenshots) {
    await captureScreenshot(
      resolve(artifactDirectory, "mime-suggestions-above.png"),
      "mime-suggestions-above",
      `ruleModal && !tooltip && suggestion?.dataset.placement === 'above' && visibleSuggestions.length > 0`,
    );
  }
  await evaluate(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-rule-condition-value-0"]');
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const condition = document.querySelector('[data-testid="ntfy-rule-condition-0"]');
      if (condition) condition.style.transform = "";
      return "placement-fixture-restored";
    })()
  `);

  await openMimeSuggestions("pdf");
  await waitFor(async () => {
    const values = await mimeSuggestionValues();
    return values.length === 1 && values[0] === "application/pdf";
  }, "filtered PDF MIME preset");
  checks.presetSearchFilters = true;
  await selectMimeSuggestion("application/pdf");
  const selectedExact = await evaluateRead(
    `document.querySelector('[data-testid="ntfy-rule-condition-value-0"]')?.value`,
  );
  assert(selectedExact === "application/pdf", "exact MIME preset was not selected");
  checks.exactPresetSelectable = true;

  await click("ntfy-rule-condition-mime-clear-0");
  const cleared = await evaluateRead(
    `document.querySelector('[data-testid="ntfy-rule-condition-value-0"]')?.value`,
  );
  assert(cleared === "", "MIME clear control did not clear the value");
  await waitFor(async () => {
    const state = await evaluateJson(`
      JSON.stringify({
        focused: document.activeElement === document.querySelector('[data-testid="ntfy-rule-condition-value-0"]'),
        suggestions: [...document.querySelectorAll('[data-testid="ntfy-rule-mime-suggestion"]')]
          .filter((item) => item.getClientRects().length > 0)
          .map((item) => item.dataset.mimeValue)
      })
    `);
    return state.focused && state.suggestions.includes("image/png");
  }, "MIME presets reopening immediately after clear");
  checks.clearControlWorks = true;
  checks.clearReopensPresetList = true;

  await evaluate(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-rule-condition-value-0"]');
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return "closed";
    })()
  `);
  await waitFor(
    async () => (await mimeSuggestionValues()).length === 0,
    "MIME presets closing with Escape",
  );
  await click("ntfy-rule-condition-value-0");
  await waitFor(
    async () => (await mimeSuggestionValues()).includes("application/pdf"),
    "active MIME input click reopening presets",
  );
  checks.activeInputClickReopensPresetList = true;

  await setInput("ntfy-rule-condition-op-0", "startsWith", "change");
  await openMimeSuggestions();
  await waitFor(
    async () => (await mimeSuggestionValues()).includes("image/"),
    "MIME family presets",
  );
  await selectMimeSuggestion("image/");
  const selectedFamily = await evaluateJson(`
    JSON.stringify({
      operator: document.querySelector('[data-testid="ntfy-rule-condition-op-0"]')?.value,
      value: document.querySelector('[data-testid="ntfy-rule-condition-value-0"]')?.value
    })
  `);
  assert(
    selectedFamily.operator === "startsWith" && selectedFamily.value === "image/",
    `MIME family selection did not update the draft controls: ${JSON.stringify(selectedFamily)}`,
  );
  checks.familyPresetSelectable = true;
  if (reviewScreenshots) {
    await captureScreenshot(
      resolve(artifactDirectory, "mime-family-selected.png"),
      "mime-family-selected",
      `ruleModal && !tooltip && byId('ntfy-rule-condition-op-0')?.value === 'startsWith' && byId('ntfy-rule-condition-value-0')?.value === 'image/' && visibleSuggestions.length === 0`,
    );
    checks.reviewScreenshotsCaptured = true;
  }
  progress("presets-and-clear-verified");

  await click("ntfy-rule-save");
  try {
    await waitFor(async () => {
      const saved = await evaluateJson(`
        (() => {
          const rule = app.plugins.getPlugin("ntfy-sync").settings.rules.rules.at(-1);
          return JSON.stringify({ count: app.plugins.getPlugin("ntfy-sync").settings.rules.rules.length, condition: rule?.when.all[0] });
        })()
      `);
      return (
        saved.count === baselineCount + 1 &&
        JSON.stringify(saved.condition) ===
          JSON.stringify({ field: "attachmentMime", op: "startsWith", value: "image/" })
      );
    }, "saved MIME condition");
  } catch (error) {
    const failureState = await evaluateJson(`
      JSON.stringify({
        ruleCount: app.plugins.getPlugin("ntfy-sync").settings.rules.rules.length,
        modalOpen: Boolean(document.querySelector('[data-testid="ntfy-rule-modal"]')),
        validation: document.querySelector('[data-testid="ntfy-rule-validation"]')?.textContent ?? ""
      })
    `);
    throw new Error(
      `${error instanceof Error ? error.message : "MIME rule save failed"}: ${JSON.stringify(failureState)}`,
    );
  }
  checks.selectionPersisted = true;

  await obsidian("plugin:reload", "id=ntfy-sync");
  const reloaded = await evaluateJson(`
    (() => {
      const rule = app.plugins.getPlugin("ntfy-sync").settings.rules.rules.at(-1);
      return JSON.stringify({ count: app.plugins.getPlugin("ntfy-sync").settings.rules.rules.length, condition: rule?.when.all[0] });
    })()
  `);
  assert(
    reloaded.count === baselineCount + 1 &&
      JSON.stringify(reloaded.condition) ===
        JSON.stringify({ field: "attachmentMime", op: "startsWith", value: "image/" }),
    "MIME condition did not survive plugin reload",
  );
  checks.reloadPersistence = true;
  progress("persistence-verified");

  const errors = await obsidian("dev:errors");
  assert(errors.includes("No errors captured."), "Obsidian captured a MIME UI error");
  const consoleErrors = await obsidian("dev:console", "level=error");
  assert(
    consoleErrors.includes("No console messages captured."),
    "console captured a MIME UI error",
  );
  checks.noNewErrors = true;
  progress("errors-checked");
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
    if (backupPath) await removeFileIfPresent(backupPath);
  }
  if (vaultName && originalData) {
    try {
      if (originalPluginEnabled) {
        await obsidian("plugin:reload", "id=ntfy-sync");
        await evaluate(
          `document.querySelectorAll('[data-testid="ntfy-rule-cancel"]').forEach((button) => button.click()); "closed"`,
        );
      } else {
        await obsidian("plugin:disable", "id=ntfy-sync");
      }
      await waitFor(
        async () =>
          ((await evaluateRead(`app.plugins.enabledPlugins.has("ntfy-sync")`)) === "true") ===
          originalPluginEnabled,
        "original plugin enabled state",
      );
      checks.originalPluginEnabledRestored = true;
    } catch {
      // Preserve restored settings even if Obsidian closes during cleanup.
      checks.originalPluginEnabledRestored = false;
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
  progress("cleanup-finished");
}

const restoredData = await readFile(dataPath);
checks.originalSettingsRestored = restoredData.equals(originalData);
checks.backupRemoved = await readFile(backupPath)
  .then(() => false)
  .catch((error) => {
    if (error?.code === "ENOENT") return true;
    throw error;
  });
assert(checks.originalSettingsRestored, "original test Vault settings were not restored");
assert(checks.viewportOverrideCleared, "Obsidian viewport override was not cleared");
assert(checks.backupRemoved, "MIME UI acceptance backup was not removed");

const report = {
  schema: "obsidian.ntfy-sync.mime-ui-acceptance.v1",
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
await writeFile(join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.passed) process.exitCode = 1;
