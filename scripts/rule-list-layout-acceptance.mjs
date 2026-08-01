import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installTestVault } from "./install-test-vault.mjs";
import { runObsidianCli } from "./obsidian-cli-runner.mjs";

const vaultName = "vanotes-test";
const pluginId = "ntfy-sync";
const runId =
  process.env.NTFY_UI_RUN_ID ?? `rules-layout-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
const artifactDirectory = resolve(".artifacts", "ui-automation", runId);
const screenshotPath = resolve(artifactDirectory, "rules-alignment.png");
const reportPath = resolve(artifactDirectory, "report.json");
await mkdir(artifactDirectory, { recursive: true });

let debugAttached = false;
let originalPluginEnabled;

async function obsidian(...args) {
  return runObsidianCli(vaultName, args);
}

async function evaluate(code) {
  const output = await obsidian("eval", `code=${code}`);
  const line = output.split(/\r?\n/u).findLast((candidate) => candidate.startsWith("=> "));
  return line?.slice(3);
}

async function evaluateJson(code) {
  const output = await evaluate(code);
  if (!output) throw new Error("Obsidian eval returned no JSON result");
  return JSON.parse(output);
}

async function waitFor(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  await obsidian("dev:debug", "off").catch(() => undefined);
  await obsidian("dev:debug", "on");
  debugAttached = true;
  const baselineErrors = await obsidian("dev:errors");
  originalPluginEnabled =
    (await evaluate(`app.plugins.enabledPlugins.has(${JSON.stringify(pluginId)})`)) === "true";

  await installTestVault({ vaultName });
  await obsidian(originalPluginEnabled ? "plugin:reload" : "plugin:enable", `id=${pluginId}`);
  await evaluate(`
    app.setting.open();
    app.setting.openTabById("about");
    app.setting.openTabById(${JSON.stringify(pluginId)});
    app.setting.activeTab?.id;
  `);
  await waitFor(async () => {
    const state = await evaluateJson(`
      (() => {
        const root = app.setting.activeTab?.containerEl;
        return JSON.stringify({
          active: app.setting.activeTab?.id,
          cards: root?.querySelectorAll(".ntfy-sync-rule-card").length ?? 0,
          list: Boolean(root?.querySelector('[data-testid="ntfy-rule-list"]'))
        });
      })()
    `);
    return state.active === pluginId && state.cards > 0 && state.list;
  }, "declarative rule list");

  const layout = await evaluateJson(`
    (() => {
      const root = app.setting.activeTab.containerEl;
      const heading = root.querySelector('[data-testid="ntfy-rules-heading"]');
      heading?.scrollIntoView({ block: "start" });
      const description = heading?.querySelector(".setting-item-description")?.textContent ?? "";
      const ruleList = root.querySelector('[data-testid="ntfy-rule-list"]');
      const firstCard = root.querySelector('[data-testid="ntfy-rule-card-0"]');
      const aligned = (left, right) => Math.abs(left - right) <= 0.5;
      const rect = (element) => {
        const value = element?.getBoundingClientRect();
        return value
          ? { left: value.left, right: value.right, width: value.width }
          : undefined;
      };
      const headingRect = rect(heading);
      const listRect = rect(ruleList);
      const cardRect = rect(firstCard);
      return JSON.stringify({
        hostTitle: root.ownerDocument.title,
        locale: root.dataset.locale,
        description,
        legacyPriorityHintPresent: description.includes("Use the arrows to set priority"),
        listUsesDeclarativeGroup: ruleList?.classList.contains("setting-group") ?? false,
        ruleListAligned: Boolean(
          headingRect && listRect &&
          aligned(listRect.left, headingRect.left) && aligned(listRect.right, headingRect.right)
        ),
        ruleListHasNoInlineSpacing: Boolean(
          ruleList &&
          Number.parseFloat(getComputedStyle(ruleList).marginLeft) === 0 &&
          Number.parseFloat(getComputedStyle(ruleList).marginRight) === 0 &&
          Number.parseFloat(getComputedStyle(ruleList).paddingLeft) === 0 &&
          Number.parseFloat(getComputedStyle(ruleList).paddingRight) === 0
        ),
        firstCardFillsList: Boolean(
          listRect && cardRect &&
          aligned(cardRect.left, listRect.left) && aligned(cardRect.right, listRect.right)
        ),
        geometry: { heading: headingRect, list: listRect, firstCard: cardRect }
      });
    })()
  `);
  if (!layout.hostTitle.includes("Obsidian 1.13.4")) {
    throw new Error(`Expected Obsidian 1.13.4, received ${layout.hostTitle}`);
  }
  if (
    !layout.listUsesDeclarativeGroup ||
    !layout.ruleListAligned ||
    !layout.ruleListHasNoInlineSpacing ||
    !layout.firstCardFillsList ||
    layout.legacyPriorityHintPresent
  ) {
    throw new Error(`Rule-list layout regression: ${JSON.stringify(layout)}`);
  }

  await evaluate(`
    (() => {
      const root = app.setting.activeTab.containerEl;
      const server = root.querySelector('[data-testid="ntfy-server-url"]');
      const topics = root.querySelector('[data-testid="ntfy-topics"]');
      if (server) server.value = "https://ntfy.example";
      if (topics) topics.value = "example-topic";
      root.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; });
      const examples = [
        ["Example links", "Examples/Links.md", "First URL host matches example.com"],
        ["Example images", "Examples/Images.md", "Has attachment: yes"],
        ["Example inbox", "Examples/Inbox.md", "All messages"]
      ];
      [...root.querySelectorAll(".ntfy-sync-rule-card")].forEach((card, index) => {
        const [nameText, pathText, summaryText] = examples[index % examples.length];
        const name = card.querySelector(".ntfy-sync-rule-card-name");
        const path = card.querySelector(".ntfy-sync-rule-card-note-path");
        const summary = card.querySelector(".setting-item-description");
        if (name) name.textContent = nameText;
        if (path) {
          path.textContent = "Note path: " + pathText;
          path.title = "Note path: " + pathText;
        }
        if (summary) summary.textContent = summaryText;
      });
      return "sanitized-render-only";
    })()
  `);

  const screenshot = await evaluateJson(`
    (async () => {
      const remote = require("@electron/remote");
      const fs = require("node:fs");
      const candidates = remote.BrowserWindow.getAllWindows()
        .filter((window) => window.isVisible());
      let target;
      for (const candidate of candidates) {
        const roots = await candidate.webContents.executeJavaScript(
          'document.querySelectorAll(".ntfy-sync-settings").length'
        );
        if (roots === 1) {
          target = candidate;
          break;
        }
      }
      if (!target) throw new Error("Rendered settings window not found");
      target.show();
      target.focus();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      const image = await target.webContents.capturePage();
      const bytes = image.toPNG();
      fs.writeFileSync(${JSON.stringify(screenshotPath)}, bytes, { mode: 0o600 });
      return JSON.stringify({
        title: target.getTitle(),
        width: image.getSize().width,
        height: image.getSize().height,
        bytes: bytes.length
      });
    })()
  `);

  await evaluate(`
    app.setting.openTabById("about");
    app.setting.openTabById(${JSON.stringify(pluginId)});
    "render-restored";
  `);
  const afterErrors = await obsidian("dev:errors");
  if (afterErrors !== baselineErrors) throw new Error("Obsidian dev:errors changed during run");

  const screenshotBytes = await readFile(screenshotPath);
  const report = {
    schema: "obsidian.ntfy-sync.rule-list-layout-acceptance.v1",
    runId,
    vault: vaultName,
    pluginId,
    layout,
    screenshot: {
      ...screenshot,
      path: screenshotPath,
      sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
    },
    checks: {
      declarativeGroupDetected: true,
      ruleListAligned: true,
      firstCardFillsList: true,
      legacyPriorityHintRemoved: true,
      screenshotSanitized: true,
      noNewErrors: true,
    },
    passed: true,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await evaluate(`
    app.setting.openTabById("about");
    app.setting.openTabById(${JSON.stringify(pluginId)});
    "render-restored";
  `).catch(() => undefined);
  if (originalPluginEnabled === false) {
    await obsidian("plugin:disable", `id=${pluginId}`).catch(() => undefined);
  }
  if (debugAttached) await obsidian("dev:debug", "off").catch(() => undefined);
}
