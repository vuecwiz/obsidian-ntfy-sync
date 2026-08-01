import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { installTestVault } from "./install-test-vault.mjs";
import { ObsidianCliTimeoutError, runObsidianCli } from "./obsidian-cli-runner.mjs";
import { captureStableScreenshot } from "./ui-screenshot.mjs";
import { normalizeDesktopViewport, restoreViewport } from "./ui-runner-viewport.mjs";

const runId =
  process.env.NTFY_COMPOSER_UI_RUN_ID ??
  `composer-ui-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const artifactDirectory = join(".artifacts", "ui-automation", runId);
await mkdir(artifactDirectory, { recursive: true });
const requestedThemes = (process.env.NTFY_COMPOSER_UI_THEMES ?? "")
  .split(",")
  .map((theme) => theme.trim())
  .filter(Boolean);

const checks = {};
let vaultName;
let dataPath;
let backupPath;
let originalData;
let originalPluginEnabled = true;
let originalTheme;
let debugAttached = false;
let viewportEvidence;
let temporaryLeafId;
let temporaryFilePath;
let server;
let obsidianVersion;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  const output = await obsidian(
    "eval",
    `code=(() => {
      const document = app.workspace.containerEl.ownerDocument;
      const window = document.defaultView;
      const innerWidth = window.innerWidth;
      const innerHeight = window.innerHeight;
      const devicePixelRatio = window.devicePixelRatio;
      const matchMedia = window.matchMedia.bind(window);
      const getComputedStyle = window.getComputedStyle.bind(window);
      const Event = window.Event;
      return eval(${JSON.stringify(code)});
    })()`,
  );
  const line = output.split(/\r?\n/u).findLast((candidate) => candidate.startsWith("=> "));
  return line?.slice(3);
}

async function evaluateJson(code) {
  const output = await evaluateRead(code);
  if (!output) throw new Error("Obsidian eval returned no JSON result");
  return JSON.parse(output);
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

async function activateTheme(theme) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await evaluate(`app.customCss.setTheme(${JSON.stringify(theme)}); app.customCss.theme`);
    await waitFor(
      async () => (await evaluateRead(`app.customCss.theme`)) === theme,
      `${theme} activation`,
    );
    // Theme loading is asynchronous. A previous setTheme call can finish late and
    // overwrite the requested theme, so require the identity to remain stable.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
    if ((await evaluateRead(`app.customCss.theme`)) === theme) return;
  }
  throw new Error(`Theme did not remain active: ${theme}`);
}

async function setInput(testId, value, eventName = "input") {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await evaluate(`
        (() => {
          const input = document.querySelector('[data-testid="${testId}"]');
          if (!input) throw new Error("missing ${testId}");
          input.value = ${JSON.stringify(value)};
          input.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
          return "changed";
        })()
      `);
      return;
    } catch (error) {
      if (!(error instanceof ObsidianCliTimeoutError) || attempt === 1) throw error;
    }
  }
}

async function selectMoreOptions(fields) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await evaluate(`
        (() => {
          const details = document.querySelector('[data-testid="ntfy-composer-more-options"]');
          if (!details) throw new Error("missing ntfy-composer-more-options");
          const selected = new Set(${JSON.stringify(fields)});
          details.open = true;
          for (const checkbox of document.querySelectorAll('.ntfy-sync-composer-multi-select-list input[type="checkbox"]')) {
            const checked = selected.has(checkbox.value);
            if (checkbox.checked === checked) continue;
            checkbox.checked = checked;
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const current = document.querySelector('[data-testid="ntfy-composer-more-options"]');
          if (current) current.open = false;
          return "selected";
        })()
      `);
      return;
    } catch (error) {
      if (!(error instanceof ObsidianCliTimeoutError) || attempt === 1) throw error;
    }
  }
}

async function setUiLanguage(locale) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await evaluate(
        `app.plugins.getPlugin("ntfy-sync").setUiLanguage(${JSON.stringify(locale)}); "localized"`,
      );
      return;
    } catch (error) {
      if (!(error instanceof ObsidianCliTimeoutError) || attempt === 1) throw error;
    }
  }
}

async function executePluginCommand(id) {
  const executed = await evaluateRead(
    `app.commands.executeCommandById(${JSON.stringify(`ntfy-sync:${id}`)})`,
  );
  assert(executed === "true", `Obsidian did not execute ntfy-sync:${id}`);
}

function startServer() {
  return new Promise((resolvePromise, rejectPromise) => {
    const requests = [];
    server = createServer((request, response) => {
      const responseHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "POST, PUT, OPTIONS",
        "Content-Type": "application/json",
      };
      if (request.method === "OPTIONS") {
        response.writeHead(204, responseHeaders).end();
        return;
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          url: request.url,
          contentType: request.headers["content-type"],
          filename: request.headers["x-filename"],
          title: request.headers["x-title"],
          tags: request.headers["x-tags"],
          priority: request.headers["x-priority"],
          click: request.headers["x-click"],
          email: request.headers["x-email"],
          delay: request.headers["x-delay"],
          markdown: request.headers["x-markdown"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, responseHeaders).end("{}");
      });
    });
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("loopback server did not expose a TCP port"));
        return;
      }
      resolvePromise({ port: address.port, requests });
    });
  });
}

async function closeServer() {
  if (!server) return;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  server = undefined;
}

try {
  const installation = await installTestVault();
  vaultName = installation.vaultName;
  assert(/test/iu.test(basename(installation.vault)), "composer acceptance requires a test Vault");
  obsidianVersion = (await obsidian("version")).trim();
  assert(/^\d+\.\d+\.\d+/u.test(obsidianVersion), "Obsidian version was not detected");
  dataPath = resolve(installation.destination, "data.json");
  backupPath = resolve(installation.destination, "data.composer-acceptance-backup.json");

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
  const loopback = await startServer();
  const acceptanceSettings = structuredClone(baseline);
  acceptanceSettings.enabled = false;
  acceptanceSettings.uiLanguage = "en";
  acceptanceSettings.connections = [
    {
      id: "primary",
      name: "Acceptance",
      baseUrl: `http://127.0.0.1:${loopback.port}`,
      topics: ["example_inbox"],
      readAuth: { kind: "none" },
      mode: "poll",
      pollIntervalSeconds: 30,
      allowInsecureHttp: true,
      initialReplay: { kind: "latest" },
      reconnect: { minMs: 1000, maxMs: 60000, jitterRatio: 1 },
    },
  ];
  await writeFile(dataPath, `${JSON.stringify(acceptanceSettings, null, 2)}\n`, { mode: 0o600 });
  checks.acceptanceConfigurationSanitized = true;

  try {
    await obsidian("dev:debug", "off");
  } catch {
    // A fresh session may not have a debugger to detach.
  }
  originalPluginEnabled =
    (await evaluateRead(`app.plugins.enabledPlugins.has("ntfy-sync")`)) === "true";
  await obsidian("dev:debug", "on");
  debugAttached = true;
  await obsidian("dev:errors", "clear");
  await obsidian("dev:console", "clear");
  if (originalPluginEnabled) await obsidian("plugin:reload", "id=ntfy-sync");
  else await obsidian("plugin:enable", "id=ntfy-sync");
  originalTheme = await evaluateRead(`app.customCss.theme`);
  checks.visualEnvironment = await evaluateJson(`
    JSON.stringify({
      originalTheme: app.customCss.theme || "Default",
      enabledCssSnippets: Array.from(app.customCss.enabledSnippets ?? []).sort()
    })
  `);
  const baselineErrors = await obsidian("dev:errors");
  assert(baselineErrors.includes("No errors captured"), "fresh plugin baseline contains errors");

  viewportEvidence = await normalizeDesktopViewport({ cdp, evaluateJson });
  checks.desktopViewportNormalized = true;

  const commands = await evaluateJson(`
    JSON.stringify(["open-message-composer", "send-selection", "send-current-note-link", "send-active-vault-file"]
      .map((id) => {
        const command = app.commands.commands["ntfy-sync:" + id];
        return {
          id,
          registered: Boolean(command),
          editorCallback: typeof command?.editorCallback === "function",
          callback: typeof command?.callback === "function",
          checkCallback: typeof command?.checkCallback === "function"
        };
      }))
  `);
  assert(
    commands.every((command) => command.registered),
    "one or more composer commands are missing",
  );
  const selectionCommand = commands.find((command) => command.id === "send-selection");
  assert(
    selectionCommand?.checkCallback &&
      !selectionCommand.editorCallback &&
      !selectionCommand.callback,
    "Send selection must use a selection-aware check callback that also supports reading view",
  );
  checks.commandsRegistered = commands.length;
  const ribbon = await evaluateJson(`
    (() => {
      const element = document.querySelector('[data-testid="ntfy-open-composer"]');
      return JSON.stringify({
        count: document.querySelectorAll('[data-testid="ntfy-open-composer"]').length,
        label: element?.getAttribute('aria-label') ?? element?.getAttribute('data-tooltip') ?? ''
      });
    })()
  `);
  assert(
    ribbon.count === 1 && ribbon.label === "Ntfy message composer",
    `message composer ribbon entry is missing, duplicated, or ambiguously named: ${JSON.stringify(ribbon)}`,
  );
  checks.ribbonEntry = true;

  await evaluate(`app.commands.executeCommandById("ntfy-sync:open-message-composer"); "opened"`);
  await waitFor(async () => {
    const state = await evaluateJson(`
      JSON.stringify({
        leaves: app.workspace.getLeavesOfType("ntfy-sync-message-composer").length,
        roots: document.querySelectorAll('[data-testid="ntfy-message-composer"]').length
      })
    `);
    return state.leaves === 1 && state.roots === 1;
  }, "right sidebar composer");

  const structure = await evaluateJson(`
    (() => {
      const root = document.querySelector('[data-testid="ntfy-message-composer"]');
      const rect = root?.getBoundingClientRect();
      const containerRect = root?.parentElement?.getBoundingClientRect();
      const required = ["connection", "topic", "title", "message", "file", "tags", "markdown", "more-options", "submit", "clear", "open-settings"];
      const inline = ["connection", "topic", "title", "file"].map((name) => {
        const input = root?.querySelector('[data-testid="ntfy-composer-' + name + '"]');
        const setting = input?.closest('.setting-item');
        const label = setting?.querySelector('.setting-item-info')?.getBoundingClientRect();
        const control = setting?.querySelector('.setting-item-control')?.getBoundingClientRect();
        const shell = input?.closest('.search-input-container') ?? input;
        const shellRect = shell?.getBoundingClientRect();
        const itemRect = setting?.getBoundingClientRect();
        return {
          name,
          delta: label && control ? Math.abs((label.top + label.bottom) / 2 - (control.top + control.bottom) / 2) : 999,
          fill: shellRect && control ? shellRect.width / control.width : 0,
          horizontalGap: label && control ? control.left - label.right : 999,
          height: itemRect?.height ?? 0,
          top: shellRect?.top ?? 0,
          bottom: shellRect?.bottom ?? 0
        };
      });
      const titleElement = root?.querySelector('[data-testid="ntfy-composer-heading-title"]');
      const titleRect = titleElement?.getBoundingClientRect();
      const settingsRect = root?.querySelector('[data-testid="ntfy-composer-open-settings"]')?.getBoundingClientRect();
      const headingX = titleRect?.left;
      const labelX = root?.querySelector('.ntfy-sync-composer-form .setting-item-name')?.getBoundingClientRect().left;
      const rowDelta = (settingSelector, rightSelector) => {
        const setting = root?.querySelector(settingSelector);
        const left = setting?.querySelector('.setting-item-name')?.getBoundingClientRect();
        const right = setting?.querySelector(rightSelector)?.getBoundingClientRect();
        return left && right ? Math.abs((left.top + left.bottom) / 2 - (right.top + right.bottom) / 2) : 999;
      };
      const tagsStyle = root ? getComputedStyle(root.querySelector('.ntfy-sync-composer-tags')) : undefined;
      const footer = root?.querySelector('.ntfy-sync-composer-footer');
      const footerStyle = footer ? getComputedStyle(footer) : undefined;
      const clearRect = root?.querySelector('[data-testid="ntfy-composer-clear"]')?.getBoundingClientRect();
      const submitRect = root?.querySelector('[data-testid="ntfy-composer-submit"]')?.getBoundingClientRect();
      const statusRect = document.querySelector('.status-bar')?.getBoundingClientRect();
      const statusIntersects = Boolean(
        rect && statusRect && statusRect.left < rect.right && statusRect.right > rect.left && statusRect.top < rect.bottom
      );
      const effectiveBottom = statusIntersects ? Math.min(rect?.bottom ?? 0, statusRect?.top ?? 0) : rect?.bottom ?? 0;
      return JSON.stringify({
        inRightSidebar: Boolean(root?.closest('.mod-right-split')),
        controls: required.filter((name) => root?.querySelector('[data-testid="ntfy-composer-' + name + '"]')).length,
        locale: root?.dataset.locale,
        overflowX: root ? root.scrollWidth - root.clientWidth : -1,
        visible: Boolean(rect && rect.width > 0 && rect.height > 0),
        connectionContainsOrigin: root?.querySelector('[data-testid="ntfy-composer-connection"]')
          ?.value.startsWith('http://127.0.0.1:') ?? false,
        inline,
        headingAlignment: Math.abs((headingX ?? -999) - (labelX ?? 999)),
        titleRow: {
          tag: titleElement?.tagName,
          topDelta: titleRect && settingsRect ? Math.abs(titleRect.top - settingsRect.top) : 999
        },
        contentInset: labelX !== undefined && containerRect ? labelX - containerRect.left : 999,
        messageHeaderDelta: rowDelta('.ntfy-sync-composer-message', '.ntfy-sync-composer-markdown-control'),
        tagsHeaderDelta: rowDelta('.ntfy-sync-composer-tags', '.ntfy-sync-composer-tags-description'),
        tagsSpacing: {
          gap: Number.parseFloat(tagsStyle?.gap ?? "999"),
          paddingTop: Number.parseFloat(tagsStyle?.paddingTop ?? "999"),
          paddingBottom: Number.parseFloat(tagsStyle?.paddingBottom ?? "999")
        },
        fileAfterMessage: Boolean(root?.querySelector('.ntfy-sync-composer-message')
          ?.compareDocumentPosition(root.querySelector('.ntfy-sync-composer-file-row')) & Node.DOCUMENT_POSITION_FOLLOWING),
        footer: {
          borderTop: Number.parseFloat(footerStyle?.borderTopWidth ?? "999"),
          borderLeft: Number.parseFloat(footerStyle?.borderLeftWidth ?? "999"),
          clearLeft: clearRect?.left ?? 999,
          clearWidth: clearRect?.width ?? 999,
          submitLeft: submitRect?.left ?? 0,
          submitWidth: submitRect?.width ?? 0,
          clearAlignment: Math.abs((clearRect?.left ?? -999) - (labelX ?? 999)),
          bottomGap: effectiveBottom - (submitRect?.bottom ?? 999)
        }
      });
    })()
  `);
  assert(structure.inRightSidebar, "composer is not mounted in the right sidebar");
  assert(structure.controls === 11, "composer controls are missing");
  assert(structure.locale === "en", "composer did not start in English");
  assert(structure.overflowX <= 1 && structure.visible, "composer layout overflows or is hidden");
  assert(structure.connectionContainsOrigin, "composer does not identify the active server origin");
  assert(
    structure.inline.every((row) => row.delta <= 3),
    `inline composer rows are misaligned: ${JSON.stringify(structure.inline)}`,
  );
  assert(
    structure.inline.slice(0, 3).every((row) => row.fill >= 0.98),
    `destination inputs do not fill the available control width: ${JSON.stringify(structure.inline)}`,
  );
  assert(
    structure.inline.slice(0, 3).every((row) => row.horizontalGap <= 5),
    `destination label gaps are too large: ${JSON.stringify(structure.inline)}`,
  );
  assert(
    structure.inline
      .slice(1, 3)
      .every((row, index) => row.top - structure.inline[index].bottom <= 16),
    `destination rows are not compact: ${JSON.stringify(structure.inline)}`,
  );
  assert(
    structure.headingAlignment <= 2,
    `composer heading is not aligned with field labels: ${structure.headingAlignment}`,
  );
  assert(
    structure.titleRow.tag === "DIV" && structure.titleRow.topDelta <= 4,
    `composer title is not ordinary text aligned with Settings: ${JSON.stringify(structure.titleRow)}`,
  );
  assert(
    structure.contentInset >= 16 && structure.contentInset <= 24,
    `composer content inset is not compact: ${structure.contentInset}`,
  );
  assert(
    structure.messageHeaderDelta <= 3 && structure.tagsHeaderDelta <= 3,
    `message/tags header accessories are not on the title line: ${JSON.stringify(structure)}`,
  );
  assert(
    structure.tagsSpacing.gap <= 4.1 &&
      structure.tagsSpacing.paddingTop <= 4.1 &&
      structure.tagsSpacing.paddingBottom <= 4.1,
    `Tags does not use compact internal spacing: ${JSON.stringify(structure.tagsSpacing)}`,
  );
  assert(
    structure.fileAfterMessage &&
      structure.inline[3].fill >= 0.98 &&
      structure.inline[3].delta <= 3,
    `Vault file is not a full-width inline row below Message: ${JSON.stringify(structure)}`,
  );
  assert(
    structure.footer.borderTop === 0 &&
      structure.footer.borderLeft === 0 &&
      structure.footer.clearLeft < structure.footer.submitLeft &&
      structure.footer.clearWidth < structure.footer.submitWidth &&
      structure.footer.clearAlignment <= 2 &&
      structure.footer.bottomGap >= 15,
    `composer footer alignment or border is incorrect: ${JSON.stringify(structure.footer)}`,
  );
  checks.rightSidebarLayout = true;

  if (requestedThemes.length > 0) {
    const themeResults = [];
    for (const theme of requestedThemes) {
      const themeId = theme === "Default" ? "" : theme;
      const installed =
        themeId === "" ||
        (await evaluateRead(`app.customCss.isThemeInstalled(${JSON.stringify(themeId)})`)) ===
          "true";
      assert(installed, `requested composer theme is not installed: ${theme}`);
      await activateTheme(themeId);
      let geometry;
      try {
        await waitFor(
          async () => {
            geometry = await evaluateJson(`
          (() => {
            const root = document.querySelector('[data-testid="ntfy-message-composer"]');
            const clear = root?.querySelector('[data-testid="ntfy-composer-clear"]');
            const submit = root?.querySelector('[data-testid="ntfy-composer-submit"]');
            const status = document.querySelector('.status-bar');
            const rootRect = root?.getBoundingClientRect();
            const clearRect = clear?.getBoundingClientRect();
            const submitRect = submit?.getBoundingClientRect();
            const statusRect = status?.getBoundingClientRect();
            const intersects = Boolean(
              rootRect && statusRect &&
              statusRect.left < rootRect.right && statusRect.right > rootRect.left &&
              statusRect.top < rootRect.bottom
            );
            const safeBottom = intersects ? statusRect.top : rootRect?.bottom ?? 0;
            return JSON.stringify({
              theme: app.customCss.theme,
              inset: Number.parseFloat(
                root ? getComputedStyle(root).getPropertyValue('--ntfy-composer-status-bar-inset') : '-1'
              ),
              gap: clearRect && submitRect
                ? Math.min(safeBottom - clearRect.bottom, safeBottom - submitRect.bottom)
                : -999,
              visible: Boolean(
                clearRect && submitRect &&
                clearRect.bottom <= safeBottom && submitRect.bottom <= safeBottom
              )
            });
          })()
        `);
            return geometry.theme === themeId && geometry.visible && geometry.gap >= 15;
          },
          `${theme} footer status-bar clearance`,
          10_000,
        );
      } catch (error) {
        throw new Error(
          `${theme} footer did not clear the status bar: ${JSON.stringify(geometry)}`,
          { cause: error },
        );
      }
      themeResults.push({ ...geometry, theme });
    }
    await activateTheme(originalTheme);
    checks.communityThemeFooterSafety = themeResults;
  }

  await setInput("ntfy-composer-connection", "Accept");
  await evaluate(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-composer-connection"]');
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return "focused";
    })()
  `);
  await waitFor(
    async () =>
      Number(
        await evaluateRead(
          `document.querySelectorAll('[data-testid="ntfy-composer-connection-suggestion"]').length`,
        ),
      ) === 1,
    "configured connection suggestion",
  );
  await evaluate(
    `document.querySelector('[data-testid="ntfy-composer-connection-suggestion"]').click(); "selected"`,
  );
  await waitFor(
    async () =>
      (await evaluateRead(
        `document.querySelector('[data-testid="ntfy-composer-connection"]')?.value`,
      )) === `http://127.0.0.1:${loopback.port}`,
    "configured connection selection",
  );
  await evaluate(
    `document.querySelector('[data-testid="ntfy-composer-connection-clear"]').click(); "cleared"`,
  );
  await waitFor(
    async () =>
      (await evaluateRead(
        `document.querySelector('[data-testid="ntfy-composer-connection"]')?.value`,
      )) === "",
    "connection clear control",
  );
  await setInput("ntfy-composer-connection", `http://127.0.0.1:${loopback.port}`);
  checks.connectionEditableSuggestedAndClearable = true;

  await evaluate(
    `document.querySelector('[data-testid="ntfy-composer-open-settings"]').click(); "settings"`,
  );
  await waitFor(
    async () => (await evaluateRead(`app.setting.activeTab?.id`)) === "ntfy-sync",
    "composer settings shortcut",
  );
  await evaluate(`app.setting.close(); "closed"`);
  checks.settingsShortcut = true;

  await evaluate(`
    (() => {
      const details = document.querySelector('[data-testid="ntfy-composer-more-options"]');
      details.open = false;
      details.querySelector('summary').click();
      return "opened";
    })()
  `);
  let visibleMultiSelect;
  await waitFor(async () => {
    visibleMultiSelect = await evaluateJson(`
      (() => {
        const details = document.querySelector('[data-testid="ntfy-composer-more-options"]');
        const summary = details?.querySelector('summary');
        const list = document.querySelector('.ntfy-sync-composer-multi-select-list');
        const checkbox = list?.querySelector('input[type="checkbox"]');
        const rect = list?.getBoundingClientRect();
        const summaryRect = summary?.getBoundingClientRect();
        return JSON.stringify({
          open: details?.open ?? false,
          popoverOpen: list?.matches(':popover-open') ?? false,
          withinViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
          alignedWithTrigger: Boolean(
            rect && summaryRect &&
            Math.abs(rect.left - summaryRect.left) <= 1 &&
            Math.abs(rect.width - summaryRect.width) <= 1 &&
            rect.top >= summaryRect.bottom
          ),
          checkboxWidth: checkbox?.getBoundingClientRect().width ?? 0
        });
      })()
    `);
    return (
      visibleMultiSelect.open &&
      visibleMultiSelect.popoverOpen &&
      visibleMultiSelect.withinViewport &&
      visibleMultiSelect.alignedWithTrigger &&
      visibleMultiSelect.checkboxWidth >= 14
    );
  }, "visible More options checkbox popover");
  checks.visibleMultiSelectPopover = true;

  const immediateMoreOptions = await evaluateJson(`
    (() => {
      const details = document.querySelector('[data-testid="ntfy-composer-more-options"]');
      details.open = true;
      document.querySelector('[data-testid="ntfy-composer-option-priority"]').click();
      const afterSelect = {
        open: document.querySelector('[data-testid="ntfy-composer-more-options"]')?.open ?? false,
        field: Boolean(document.querySelector('[data-testid="ntfy-composer-priority"]'))
      };
      document.querySelector('[data-testid="ntfy-composer-option-priority"]').click();
      const afterClear = {
        open: document.querySelector('[data-testid="ntfy-composer-more-options"]')?.open ?? false,
        field: Boolean(document.querySelector('[data-testid="ntfy-composer-priority"]'))
      };
      document.querySelector('.ntfy-sync-composer-heading').dispatchEvent(
        new Event("pointerdown", { bubbles: true })
      );
      const outsideClosed =
        document.querySelector('[data-testid="ntfy-composer-more-options"]')?.open === false;
      return JSON.stringify({ afterSelect, afterClear, outsideClosed });
    })()
  `);
  assert(
    immediateMoreOptions.afterSelect.open &&
      immediateMoreOptions.afterSelect.field &&
      immediateMoreOptions.afterClear.open &&
      !immediateMoreOptions.afterClear.field &&
      immediateMoreOptions.outsideClosed,
    `More options changes are not immediate while open: ${JSON.stringify(immediateMoreOptions)}`,
  );
  checks.immediateMultiSelectUpdates = true;
  checks.multiSelectOutsideClickCloses = true;

  const selectedOptions = ["priority", "clickUrl", "email", "attachmentUrl", "delay"];
  await selectMoreOptions(selectedOptions);
  for (const fieldTestId of [
    "ntfy-composer-priority",
    "ntfy-composer-click-url",
    "ntfy-composer-email",
    "ntfy-composer-attachment-url",
    "ntfy-composer-delay",
  ]) {
    await waitFor(
      async () =>
        (await evaluateRead(
          `Boolean(document.querySelector('[data-testid=${JSON.stringify(fieldTestId)}]'))`,
        )) === "true",
      `${fieldTestId} render`,
    );
    const expandsDownward = await evaluateRead(`
      (() => {
        const more = document.querySelector('[data-testid="ntfy-composer-more-options"]')?.closest('.setting-item');
        const field = document.querySelector('[data-testid=${JSON.stringify(fieldTestId)}]')?.closest('.setting-item');
        return Boolean(more && field && (more.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING));
      })()
    `);
    assert(expandsDownward === "true", `${fieldTestId} did not expand below More options`);
  }
  const multiSelectState = await evaluateJson(`
    (() => {
      const details = document.querySelector('[data-testid="ntfy-composer-more-options"]');
      const summary = details?.querySelector('summary');
      const option = document.querySelector('.ntfy-sync-composer-multi-select-option');
      const priority = document.querySelector('[data-testid="ntfy-composer-priority"]');
      return JSON.stringify({
        element: details?.tagName,
        checkboxes: document.querySelectorAll('.ntfy-sync-composer-multi-select-list input[type="checkbox"]').length,
        checked: document.querySelectorAll('.ntfy-sync-composer-multi-select-list input[type="checkbox"]:checked').length,
        removeButtons: document.querySelectorAll('[data-testid$="-remove"]').length,
        fontSizes: {
          summary: summary ? getComputedStyle(summary).fontSize : '',
          option: option ? getComputedStyle(option).fontSize : '',
          priority: priority ? getComputedStyle(priority).fontSize : ''
        }
      });
    })()
  `);
  assert(
    multiSelectState.element === "DETAILS" &&
      multiSelectState.checkboxes === 5 &&
      multiSelectState.checked === 5 &&
      multiSelectState.removeButtons === 0 &&
      multiSelectState.fontSizes.summary === multiSelectState.fontSizes.priority &&
      multiSelectState.fontSizes.option === multiSelectState.fontSizes.priority,
    `More options is not a five-field checkbox dropdown: ${JSON.stringify(multiSelectState)}`,
  );
  const compactRows = await evaluateJson(`
    (() => {
      const root = document.querySelector('[data-testid="ntfy-message-composer"]');
      const ids = ["connection", "file", "priority", "click-url", "email", "attachment-url", "filename", "delay"];
      return JSON.stringify(ids.map((id) => ({
        id,
        height: root.querySelector('[data-testid="ntfy-composer-' + id + '"]')
          ?.closest('.setting-item')?.getBoundingClientRect().height ?? 0
      })));
    })()
  `);
  const compactBaseline = compactRows[0].height;
  assert(
    compactRows.every((row) => Math.abs(row.height - compactBaseline) <= 1),
    `optional field rows do not match the compact destination height: ${JSON.stringify(compactRows)}`,
  );
  checks.compactPublishFieldRows = true;
  await selectMoreOptions(["clickUrl", "email", "attachmentUrl", "delay"]);
  await waitFor(
    async () =>
      (await evaluateRead(
        `Boolean(document.querySelector('[data-testid="ntfy-composer-priority"]'))`,
      )) === "false",
    "priority removal",
  );
  await selectMoreOptions(selectedOptions);
  await waitFor(
    async () =>
      (await evaluateRead(
        `Boolean(document.querySelector('[data-testid="ntfy-composer-priority"]'))`,
      )) === "true",
    "priority re-add",
  );
  checks.multiSelectMoreOptions = true;
  await setInput("ntfy-composer-click-url", "https://example.com/build/42");
  await setInput("ntfy-composer-email", "mobile@example.com");
  await setInput("ntfy-composer-attachment-url", "https://example.com/result.png");
  await setInput("ntfy-composer-filename", "result.png");
  await setInput("ntfy-composer-delay", "30m");
  await evaluate(
    `document.querySelector('[data-testid="ntfy-composer-markdown"]').click(); "markdown"`,
  );

  await setInput("ntfy-composer-topic", "mobile_notifications");
  await setInput("ntfy-composer-title", "Example build");
  await setInput("ntfy-composer-message", "Example payload");
  await setInput("ntfy-composer-tags", "build, example");
  await setInput("ntfy-composer-priority", "4", "change");
  await evaluate(`
    (() => {
      const message = document.querySelector('[data-testid="ntfy-composer-message"]');
      message.rows = 10;
      message.style.height = '222px';
      document.querySelector('[data-testid="ntfy-composer-clear"]').click();
      return "cleared";
    })()
  `);
  const clearedDraft = await evaluateJson(`
    (() => {
      const value = (id) => document.querySelector('[data-testid="' + id + '"]')?.value ?? null;
      const message = document.querySelector('[data-testid="ntfy-composer-message"]');
      return JSON.stringify({
        connection: value('ntfy-composer-connection'),
        topic: value('ntfy-composer-topic'),
        priority: value('ntfy-composer-priority'),
        markdown: document.querySelector('[data-testid="ntfy-composer-markdown"]')?.classList.contains('is-enabled'),
        selectedOptions: document.querySelectorAll('.ntfy-sync-composer-multi-select-list input[type="checkbox"]:checked').length,
        optionalFields: ['click-url', 'email', 'attachment-url', 'filename', 'delay']
          .filter((id) => document.querySelector('[data-testid="ntfy-composer-' + id + '"]')).length,
        clearedValues: ['title', 'message', 'file', 'tags', 'click-url', 'email', 'attachment-url', 'filename', 'delay']
          .map((id) => value('ntfy-composer-' + id)),
        messageRows: message?.rows,
        messageHeight: message?.style.height
      });
    })()
  `);
  assert(
    clearedDraft.connection.startsWith("http://127.0.0.1:") &&
      clearedDraft.topic === "mobile_notifications" &&
      clearedDraft.priority === "4" &&
      clearedDraft.markdown &&
      clearedDraft.selectedOptions === 5 &&
      clearedDraft.optionalFields === 5 &&
      clearedDraft.clearedValues.every((value) => value === "") &&
      clearedDraft.messageRows === 10 &&
      clearedDraft.messageHeight === "222px",
    `Clear changed composer structure or retained payload values: ${JSON.stringify(clearedDraft)}`,
  );
  checks.clearPreservesComposerStructure = true;
  await evaluate(
    `document.querySelector('[data-testid="ntfy-composer-submit"]').click(); "clicked"`,
  );
  const validationTypography = await evaluateJson(`
    (() => {
      const root = document.querySelector('[data-testid="ntfy-message-composer"]');
      const validation = document.querySelector('[data-testid="ntfy-composer-validation"]');
      return JSON.stringify({
        text: validation?.textContent ?? '',
        feedbackFontSize: Number.parseFloat(getComputedStyle(validation).fontSize),
        composerFontSize: Number.parseFloat(getComputedStyle(root).fontSize)
      });
    })()
  `);
  assert(
    validationTypography.text === "Enter a message to publish." &&
      validationTypography.feedbackFontSize <= validationTypography.composerFontSize,
    `Composer validation typography is inconsistent: ${JSON.stringify(validationTypography)}`,
  );
  checks.compactFeedbackTypography = true;
  await setInput("ntfy-composer-title", "Example build");
  await setInput("ntfy-composer-message", "Example payload");
  await setInput("ntfy-composer-tags", "build, example");
  await setInput("ntfy-composer-click-url", "https://example.com/build/42");
  await setInput("ntfy-composer-email", "mobile@example.com");
  await setInput("ntfy-composer-attachment-url", "https://example.com/result.png");
  await setInput("ntfy-composer-filename", "result.png");
  await setInput("ntfy-composer-delay", "30m");
  await evaluate(
    `document.querySelector('[data-testid="ntfy-composer-submit"]').click(); "clicked"`,
  );
  await waitFor(() => Promise.resolve(loopback.requests.length === 1), "loopback publish request");
  let lastPublishState;
  try {
    await waitFor(async () => {
      lastPublishState = await evaluateJson(`
        (() => {
          const status = document.querySelector('[data-testid="ntfy-composer-status"]');
          const button = document.querySelector('[data-testid="ntfy-composer-submit"]');
          const statusRect = status?.getBoundingClientRect();
          const buttonRect = button?.getBoundingClientRect();
          const statusPaddingRight = status ? Number.parseFloat(getComputedStyle(status).paddingRight) : 0;
          return JSON.stringify({
            status: status?.textContent ?? '',
            error: document.querySelector('[data-testid="ntfy-composer-validation"]')?.textContent ?? '',
            button: button?.textContent ?? '',
            feedbackFontSize: Number.parseFloat(getComputedStyle(status).fontSize),
            composerFontSize: Number.parseFloat(getComputedStyle(document.querySelector('[data-testid="ntfy-message-composer"]')).fontSize),
            statusAboveButton: Boolean(statusRect && buttonRect && statusRect.bottom <= buttonRect.top),
            rightAlignment: statusRect && buttonRect
              ? Math.abs(statusRect.right - statusPaddingRight - buttonRect.right)
              : 999
          });
        })()
      `);
      return (
        lastPublishState.status === "Message published" &&
        lastPublishState.error === "" &&
        lastPublishState.feedbackFontSize <= lastPublishState.composerFontSize &&
        lastPublishState.statusAboveButton &&
        lastPublishState.rightAlignment <= 2
      );
    }, "publish success state");
  } catch (error) {
    throw new Error(`Publish status did not settle: ${JSON.stringify(lastPublishState)}`, {
      cause: error,
    });
  }
  checks.publishFeedbackAboveButton = true;
  const published = loopback.requests[0];
  const payload = JSON.parse(published.body);
  assert(published.method === "POST" && published.url === "/", "unexpected publish request target");
  assert(
    payload.topic === "mobile_notifications" &&
      payload.title === "Example build" &&
      payload.message === "Example payload" &&
      payload.priority === 4 &&
      payload.cache === "yes" &&
      payload.click === "https://example.com/build/42" &&
      payload.email === "mobile@example.com" &&
      payload.delay === "30m" &&
      payload.markdown === true &&
      payload.attach === "https://example.com/result.png" &&
      payload.filename === "result.png" &&
      JSON.stringify(payload.tags) === JSON.stringify(["build", "example"]),
    "published payload does not match the composer draft",
  );
  checks.realLoopbackPublish = true;
  checks.officialOptionalFieldsPublish = true;

  const fixtureName = `ntfy-composer-acceptance-${randomBytes(4).toString("hex")}.md`;
  temporaryFilePath = fixtureName;
  const leafState = await evaluateJson(`
    (async () => {
      const path = ${JSON.stringify(fixtureName)};
      const file = await app.vault.create(
        path,
        "Selected example text\\nReading view example\\n",
      );
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      await leaf.setViewState({
        type: "markdown",
        state: { file: path, mode: "source", source: false }
      });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      return JSON.stringify({ leafId: leaf.id });
    })()
  `);
  temporaryLeafId = leafState.leafId;

  await evaluateRead(`
    (() => {
      const leaf = app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)});
      app.workspace.setActiveLeaf(leaf, { focus: true });
      leaf.view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 16 });
      return "selection-ready";
    })()
  `);
  await waitFor(
    async () =>
      (await evaluateRead(`app.workspace.activeEditor?.editor?.getSelection()`)) ===
      "Selected example",
    "active editor selection",
  );
  await executePluginCommand("send-selection");
  let selectionPrefillValue = "";
  try {
    await waitFor(async () => {
      selectionPrefillValue =
        (await evaluateRead(
          `document.querySelector('[data-testid="ntfy-composer-message"]')?.value`,
        )) ?? "";
      return selectionPrefillValue === "Selected example";
    }, "selection command prefill");
  } catch (error) {
    throw new Error(`Selection command left composer value: ${selectionPrefillValue}`, {
      cause: error,
    });
  }
  checks.editorSelectionCommandPrefill = true;

  await setInput("ntfy-composer-message", "Before reading-view selection");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await evaluateRead(`
      (async () => {
        const leaf = app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)});
        app.workspace.setActiveLeaf(leaf, { focus: true });
        await leaf.setViewState({
          type: "markdown",
          state: { file: ${JSON.stringify(fixtureName)}, mode: "preview", source: false }
        });
        return "reading-view-opened";
      })()
    `);
    try {
      await waitFor(
        async () =>
          (await evaluateRead(`
            app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)})?.view.containerEl
              .querySelector('.markdown-preview-view')?.textContent.includes('Reading view example')
          `)) === "true",
        "reading-view preview render",
        10_000,
      );
      break;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  const readingSelection = await evaluate(`
    (() => {
      const leaf = app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)});
      const preview = leaf.view.containerEl.querySelector('.markdown-preview-view');
      const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const index = node.nodeValue?.indexOf('Reading view example') ?? -1;
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 'Reading view example'.length);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return selection.toString();
      }
      throw new Error('reading-view selection target did not render');
    })()
  `);
  assert(readingSelection === "Reading view example", "reading-view text was not selected");
  await waitFor(
    async () =>
      (await evaluateRead(
        `app.commands.commands["ntfy-sync:send-selection"].checkCallback(true)`,
      )) === "true",
    "reading-view selection command availability",
  );
  await executePluginCommand("send-selection");
  await waitFor(
    async () =>
      (await evaluateRead(
        `document.querySelector('[data-testid="ntfy-composer-message"]')?.value`,
      )) === "Reading view example",
    "reading-view selection command prefill",
  );
  checks.readingViewSelectionCommandPrefill = true;

  await evaluate(`
    (() => {
      const leaf = app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)});
      app.workspace.setActiveLeaf(leaf, { focus: true });
      app.commands.executeCommandById("ntfy-sync:send-current-note-link");
      return "note-link-command";
    })()
  `);
  const noteLinkPrefill = await evaluateJson(`
    JSON.stringify({
      titlePresent: Boolean(document.querySelector('[data-testid="ntfy-composer-title"]')?.value),
      isObsidianLink: document.querySelector('[data-testid="ntfy-composer-message"]')?.value
        .startsWith('obsidian://open?vault=') ?? false,
      oneLeaf: app.workspace.getLeavesOfType("ntfy-sync-message-composer").length === 1
    })
  `);
  assert(
    noteLinkPrefill.titlePresent && noteLinkPrefill.isObsidianLink && noteLinkPrefill.oneLeaf,
    "current-note command did not reuse and prefill the composer",
  );
  checks.noteLinkCommandPrefill = true;

  await evaluate(`
    (() => {
      const leaf = app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)});
      app.workspace.setActiveLeaf(leaf, { focus: true });
      app.commands.executeCommandById("ntfy-sync:send-active-vault-file");
      return "file-command";
    })()
  `);
  const filePrefill = await evaluateRead(
    `document.querySelector('[data-testid="ntfy-composer-file"]')?.value`,
  );
  assert(filePrefill === fixtureName, "active-file command did not prefill the Vault path");
  checks.activeFileCommandPrefill = true;

  await setInput("ntfy-composer-topic", "example_inbox");
  await setInput("ntfy-composer-title", "Example file");
  await setInput("ntfy-composer-message", "File example");
  await setInput("ntfy-composer-tags", "file, example");
  await setInput("ntfy-composer-priority", "5", "change");
  await evaluate(`
    (() => {
      const input = document.querySelector('[data-testid="ntfy-composer-message"]');
      input.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
        ctrlKey: true
      }));
      return "keyboard-publish";
    })()
  `);
  await waitFor(
    () => Promise.resolve(loopback.requests.length === 2),
    "Vault file publish request",
  );
  const fileRequest = loopback.requests[1];
  assert(
    fileRequest.method === "PUT" &&
      fileRequest.url === "/example_inbox" &&
      fileRequest.filename === fixtureName &&
      fileRequest.title === "Example file" &&
      fileRequest.tags === "file,example" &&
      fileRequest.priority === "5" &&
      fileRequest.click === "https://example.com/build/42" &&
      fileRequest.email === "mobile@example.com" &&
      fileRequest.delay === "30m" &&
      fileRequest.markdown === "true" &&
      fileRequest.body === "Selected example text\nReading view example\n",
    "Vault file keyboard publish does not match the composer draft",
  );
  checks.vaultFileKeyboardPublish = true;

  await setUiLanguage("zh-CN");
  await waitFor(async () => {
    const locale = await evaluateJson(`
      JSON.stringify({
        locale: document.querySelector('[data-testid="ntfy-message-composer"]')?.dataset.locale,
        title: document.querySelector('[data-testid="ntfy-composer-heading-title"]')?.textContent
      })
    `);
    return locale.locale === "zh-CN" && locale.title === "发布 Ntfy 通知";
  }, "Simplified Chinese composer");
  await setUiLanguage("en");
  await waitFor(async () => {
    const locale = await evaluateJson(`
      JSON.stringify({
        locale: document.querySelector('[data-testid="ntfy-message-composer"]')?.dataset.locale,
        title: document.querySelector('[data-testid="ntfy-composer-heading-title"]')?.textContent
      })
    `);
    return locale.locale === "en" && locale.title === "Publish Ntfy notification";
  }, "English composer restoration");
  checks.bilingualImmediateRefresh = true;

  const themeEvidence = await evaluateJson(`
    (() => {
      const body = document.body;
      const wasLight = body.classList.contains("theme-light");
      const wasDark = body.classList.contains("theme-dark");
      const read = () => {
        const root = document.querySelector('[data-testid="ntfy-message-composer"]');
        const input = root?.querySelector('[data-testid="ntfy-composer-title"]');
        return {
          overflowX: root ? root.scrollWidth - root.clientWidth : -1,
          inputBackground: input ? getComputedStyle(input).backgroundColor : "",
          panelBackground: root?.closest('.workspace-leaf-content')
            ? getComputedStyle(root.closest('.workspace-leaf-content')).backgroundColor
            : "",
          themePrimary: root
            ? getComputedStyle(root).getPropertyValue('--background-primary').trim()
            : "",
          textColor: root ? getComputedStyle(root).color : ""
        };
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
    themeEvidence.light.overflowX <= 1 &&
      themeEvidence.dark.overflowX <= 1 &&
      themeEvidence.light.themePrimary !== themeEvidence.dark.themePrimary &&
      themeEvidence.light.textColor !== themeEvidence.dark.textColor,
    `composer does not adapt cleanly to light and dark themes: ${JSON.stringify(themeEvidence)}`,
  );
  checks.lightAndDarkThemes = true;

  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 0,
    mobile: false,
  });
  await waitFor(async () => {
    const viewport = await evaluateJson(`
        JSON.stringify({
          width: window.innerWidth * window.devicePixelRatio,
          height: window.innerHeight * window.devicePixelRatio
        })
      `);
    return Math.abs(viewport.width - 1440) <= 2 && Math.abs(viewport.height - 900) <= 2;
  }, "documentation viewport 1440x900");
  checks.documentationViewport = "1440x900";

  await evaluate(`
    (() => {
      document.getElementById("ntfy-composer-privacy-mask")?.remove();
      document.getElementById("ntfy-composer-documentation-main")?.remove();
      const style = document.createElement("style");
      style.id = "ntfy-composer-privacy-mask";
      style.textContent = \`
        .mod-left-split,
        .notice-container,
        .modal-container { visibility: hidden; }
        .status-bar-item:not([data-testid="ntfy-sync-status"]) { visibility: hidden; }
        #ntfy-composer-documentation-main {
          background: var(--background-primary);
          color: var(--text-normal);
          overflow: hidden;
          padding: 3.5rem 4rem;
          position: fixed;
          visibility: visible;
          z-index: 20;
        }
        #ntfy-composer-documentation-main .ntfy-doc-kicker {
          color: var(--text-accent);
          font-size: var(--font-ui-small);
          font-weight: var(--font-semibold);
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        #ntfy-composer-documentation-main h1 { margin: 0.5rem 0 0.75rem; }
        #ntfy-composer-documentation-main h2 { font-size: var(--font-ui-large); margin: 2rem 0 0.75rem; }
        #ntfy-composer-documentation-main p { color: var(--text-muted); max-width: 40rem; }
        #ntfy-composer-documentation-main .ntfy-doc-grid {
          display: grid;
          gap: 1rem;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin-top: 1.5rem;
          max-width: 44rem;
        }
        #ntfy-composer-documentation-main .ntfy-doc-card {
          background: var(--background-secondary);
          border: 1px solid var(--background-modifier-border);
          border-radius: var(--radius-m);
          padding: 1rem 1.25rem;
        }
        #ntfy-composer-documentation-main .ntfy-doc-card strong { display: block; margin-bottom: 0.35rem; }
        #ntfy-composer-documentation-main .ntfy-doc-card span { color: var(--text-muted); font-size: var(--font-ui-small); }
      \`;
      document.head.append(style);
      const documentationLeaf = app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)});
      const contentRect = documentationLeaf?.view?.containerEl
        ?.querySelector('.view-content')
        ?.getBoundingClientRect();
      const main = document.body.createDiv({
        attr: { id: 'ntfy-composer-documentation-main' }
      });
      if (contentRect) {
        main.setCssStyles({
          height: String(contentRect.height) + 'px',
          left: String(contentRect.left) + 'px',
          top: String(contentRect.top) + 'px',
          width: String(contentRect.width) + 'px'
        });
      }
      main?.createDiv({ cls: 'ntfy-doc-kicker' });
      main?.createEl('h1');
      main?.createEl('p');
      main?.createEl('h2');
      const grid = main?.createDiv({ cls: 'ntfy-doc-grid' });
      for (let index = 0; index < 4; index += 1) {
        const card = grid?.createDiv({ cls: 'ntfy-doc-card' });
        card?.createEl('strong');
        card?.createEl('span');
      }
      return "privacy-mask-installed";
    })()
  `);

  const captureDocumentationScreenshot = async ({
    locale,
    values,
    filename,
    label,
    scrollToOptions = false,
    openMoreOptions = false,
  }) => {
    await setUiLanguage(locale);
    await waitFor(
      async () =>
        (await evaluateRead(
          `document.querySelector('[data-testid="ntfy-message-composer"]')?.dataset.locale`,
        )) === locale,
      `${label} locale`,
    );
    await evaluate(`
      (() => {
        const root = document.querySelector('[data-testid="ntfy-message-composer"]');
        const main = document.getElementById('ntfy-composer-documentation-main');
        const localized = ${JSON.stringify(locale)} === 'zh-CN'
          ? {
              kicker: 'NTFY SYNC · 主动通知',
              title: '从 Obsidian 发布通知',
              intro: '在右侧边栏编写通知，选择连接、主题和可选参数，再发布到手机、浏览器或其他 ntfy 订阅端。',
              section: '通知发布流程',
              cards: [
                ['1 · 选择目标', '使用已配置连接，或输入另一个 ntfy 服务地址与主题。'],
                ['2 · 编写内容', '添加标题、纯文本或 Markdown 正文，也可选择 Vault 文件。'],
                ['3 · 设置选项', '按需选择优先级、点击链接、邮件、附件 URL 和延迟投递。'],
                ['4 · 发布验证', '服务器接受请求后显示“消息已发布”，草稿仍可继续编辑。']
              ]
            }
          : {
              kicker: 'NTFY SYNC · OUTBOUND NOTIFICATIONS',
              title: 'Publish notifications from Obsidian',
              intro: 'Compose in the right sidebar, choose a connection, topic, and optional parameters, then publish to phones, browsers, or any other ntfy subscriber.',
              section: 'Notification publishing flow',
              cards: [
                ['1 · Choose a target', 'Use a configured connection or enter another ntfy service URL and topic.'],
                ['2 · Compose', 'Add a title, plain text or Markdown message, and optionally a Vault file.'],
                ['3 · Add options', 'Select priority, Click URL, email, attachment URL, or delayed delivery as needed.'],
                ['4 · Publish and verify', 'After the server accepts the request, the composer reports “Message published”.']
              ]
            };
        const documentationLeaf = app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)});
        const tabTitle = documentationLeaf?.tabHeaderEl
          ?.querySelector('.workspace-tab-header-inner-title');
        if (tabTitle) {
          tabTitle.textContent = ${JSON.stringify(locale)} === 'zh-CN'
            ? 'Ntfy 通知示例'
            : 'Ntfy notification example';
        }
        if (main) {
          main.querySelector('.ntfy-doc-kicker').textContent = localized.kicker;
          main.querySelector('h1').textContent = localized.title;
          main.querySelector('p').textContent = localized.intro;
          main.querySelector('h2').textContent = localized.section;
          main.querySelectorAll('.ntfy-doc-card').forEach((card, index) => {
            card.querySelector('strong').textContent = localized.cards[index][0];
            card.querySelector('span').textContent = localized.cards[index][1];
          });
        }
        const setValue = (id, value) => {
          const input = root.querySelector('[data-testid="' + id + '"]');
          if (input) input.value = value;
        };
        setValue("ntfy-composer-connection", ${JSON.stringify(values.connection)});
        setValue("ntfy-composer-topic", ${JSON.stringify(values.topic)});
        setValue("ntfy-composer-title", ${JSON.stringify(values.title)});
        setValue("ntfy-composer-message", ${JSON.stringify(values.message)});
        setValue("ntfy-composer-file", ${JSON.stringify(values.file)});
        setValue("ntfy-composer-tags", ${JSON.stringify(values.tags)});
        setValue("ntfy-composer-click-url", "https://example.com/details");
        setValue("ntfy-composer-email", "mobile@example.com");
        setValue("ntfy-composer-attachment-url", "https://example.com/image.png");
        setValue("ntfy-composer-filename", "image.png");
        setValue("ntfy-composer-delay", "30m");
        const form = root.querySelector('.ntfy-sync-composer-form');
        form.scrollTop = ${scrollToOptions ? "form.scrollHeight" : "0"};
        root.querySelector('[data-testid="ntfy-composer-more-options"]').open = ${openMoreOptions};
        return "sanitized";
      })()
    `);
    return captureStableScreenshot({
      path: join(artifactDirectory, filename),
      label,
      cdp,
      timeoutMs: 20_000,
      readState: () =>
        evaluateJson(`
          (() => {
            const root = document.querySelector('[data-testid="ntfy-message-composer"]');
            const rect = root?.getBoundingClientRect();
            return JSON.stringify({
              ready: Boolean(root && rect.width > 0 && rect.height > 0),
              signature: {
                locale: root?.dataset.locale,
                width: Math.round(rect?.width ?? 0),
                height: Math.round(rect?.height ?? 0),
                title: root?.querySelector('[data-testid="ntfy-composer-heading-title"]')?.textContent,
                connection: root?.querySelector('[data-testid="ntfy-composer-connection"]')?.value,
                controls: root?.querySelectorAll('[data-testid]').length ?? 0,
                scrollTop: Math.round(root?.querySelector('.ntfy-sync-composer-form')?.scrollTop ?? 0),
                moreOptionsOpen: root?.querySelector('[data-testid="ntfy-composer-more-options"]')?.open ?? false
              }
            });
          })()
        `),
    });
  };

  await selectMoreOptions([]);

  const englishScreenshot = await captureDocumentationScreenshot({
    locale: "en",
    filename: "message-composer.png",
    label: "English message composer",
    values: {
      connection: "https://ntfy.example.com",
      topic: "example_topic",
      title: "Example notification",
      message: "Example message",
      file: "Examples/example.md",
      tags: "example, mobile",
    },
  });
  const simplifiedChineseScreenshot = await captureDocumentationScreenshot({
    locale: "zh-CN",
    filename: "message-composer-cn.png",
    label: "Simplified Chinese message composer",
    values: {
      connection: "https://ntfy.example.com",
      topic: "example_topic",
      title: "示例通知",
      message: "示例消息",
      file: "Examples/example.md",
      tags: "example, mobile",
    },
  });

  await selectMoreOptions(selectedOptions);

  const englishOptionsScreenshot = await captureDocumentationScreenshot({
    locale: "en",
    filename: "message-composer-options.png",
    label: "English message composer optional fields",
    scrollToOptions: true,
    values: {
      connection: "https://ntfy.example.com",
      topic: "example_topic",
      title: "Example notification",
      message: "Example message",
      file: "",
      tags: "example, mobile",
    },
  });
  const simplifiedChineseOptionsScreenshot = await captureDocumentationScreenshot({
    locale: "zh-CN",
    filename: "message-composer-options-cn.png",
    label: "Simplified Chinese message composer optional fields",
    scrollToOptions: true,
    values: {
      connection: "https://ntfy.example.com",
      topic: "example_topic",
      title: "示例通知",
      message: "示例消息",
      file: "",
      tags: "example, mobile",
    },
  });
  checks.sanitizedScreenshots = {
    english: englishScreenshot,
    simplifiedChinese: simplifiedChineseScreenshot,
    englishOptions: englishOptionsScreenshot,
    simplifiedChineseOptions: simplifiedChineseOptionsScreenshot,
  };
  await setUiLanguage("en");

  await evaluate(`
    (() => {
      document.getElementById("ntfy-composer-privacy-mask")?.remove();
      document.getElementById("ntfy-composer-documentation-main")?.remove();
      app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)})?.detach();
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(fixtureName)});
      if (file) return app.vault.delete(file).then(() => "cleaned");
      return "cleaned";
    })()
  `);
  temporaryLeafId = undefined;
  temporaryFilePath = undefined;

  await obsidian("plugin:disable", "id=ntfy-sync");
  const rollback = await evaluateJson(`
    JSON.stringify({
      leaves: app.workspace.getLeavesOfType("ntfy-sync-message-composer").length,
      commandPresent: Boolean(app.commands.commands["ntfy-sync:open-message-composer"])
    })
  `);
  assert(
    rollback.leaves === 0 && !rollback.commandPresent,
    "plugin disable did not clean up view/commands",
  );
  checks.rollbackCleanup = true;

  const postErrors = await obsidian("dev:errors");
  assert(postErrors.includes("No errors captured"), "composer scenario introduced renderer errors");
  checks.noNewObsidianErrors = true;

  const restoration = await restoreViewport({ cdp, evaluateJson }, viewportEvidence);
  assert(restoration.cleared, "CDP viewport override was not cleared");
  checks.viewportOverrideCleared = true;
  await obsidian("dev:debug", "off");
  debugAttached = false;

  const report = {
    schema: "obsidian.ntfy-sync.composer-acceptance.v1",
    runId,
    target: { vault: vaultName, obsidian: obsidianVersion },
    checks,
    passed: true,
  };
  await writeFile(join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (viewportEvidence && debugAttached) {
    await restoreViewport({ cdp, evaluateJson }, viewportEvidence).catch(() => undefined);
  }
  if (debugAttached) await obsidian("dev:debug", "off").catch(() => undefined);
  await evaluate(
    `document.getElementById("ntfy-composer-privacy-mask")?.remove(); document.getElementById("ntfy-composer-documentation-main")?.remove(); "removed"`,
  ).catch(() => undefined);
  if (temporaryLeafId) {
    await evaluate(
      `app.workspace.getLeafById(${JSON.stringify(temporaryLeafId)})?.detach(); "detached"`,
    ).catch(() => undefined);
  }
  if (temporaryFilePath) {
    await evaluate(`
      (() => {
        const file = app.vault.getAbstractFileByPath(${JSON.stringify(temporaryFilePath)});
        return file ? app.vault.delete(file).then(() => "deleted") : "missing";
      })()
    `).catch(() => undefined);
  }
  if (originalTheme !== undefined && vaultName) {
    await evaluate(
      `app.customCss.setTheme(${JSON.stringify(originalTheme)}); app.customCss.theme`,
    ).catch(() => undefined);
  }
  await closeServer().catch(() => undefined);
  if (originalData && dataPath) await writeFile(dataPath, originalData, { mode: 0o600 });
  if (backupPath) await removeFileIfPresent(backupPath);
  if (vaultName) {
    const enabled =
      (await evaluateRead(`app.plugins.enabledPlugins.has("ntfy-sync")`).catch(() => "false")) ===
      "true";
    if (originalPluginEnabled) {
      if (enabled) await obsidian("plugin:reload", "id=ntfy-sync").catch(() => undefined);
      else await obsidian("plugin:enable", "id=ntfy-sync").catch(() => undefined);
    } else if (enabled) {
      await obsidian("plugin:disable", "id=ntfy-sync").catch(() => undefined);
    }
  }
}
