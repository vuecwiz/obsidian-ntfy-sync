import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const defaultResolutions = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];
const matrixId =
  process.env.NTFY_UI_MATRIX_ID ??
  `common-desktop-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
const matrixRoot = resolve(".artifacts", "ui-review", matrixId);
const resolutions = parseResolutions(process.env.NTFY_UI_RESOLUTIONS);
const pluginLanguage = process.env.NTFY_UI_PLUGIN_LANGUAGE ?? "en";
if (pluginLanguage !== "en" && pluginLanguage !== "zh-CN") {
  throw new Error(`Unsupported NTFY_UI_PLUGIN_LANGUAGE: ${pluginLanguage}`);
}
const hostLanguage = process.env.NTFY_UI_EXPECTED_OBSIDIAN_LANGUAGE;
const chinesePlugin = pluginLanguage === "zh-CN";
const generalScreenshots = [
  [
    "documentation-general-settings.png",
    chinesePlugin ? "通用设置" : "General settings",
    "验证独立透明的插件标题、接收开关、主连接标题右侧 Publish test 与 Apply，以及连接和认证控件。",
  ],
  [
    "publish-test-modal-layout.png",
    chinesePlugin ? "发布测试消息弹窗" : "Publish test message modal",
    "验证主题使用带搜索与清空按钮的单行输入框，预填并建议已配置输入主题，同时提供优先级、文本/图片 Vault 文件、内容、发布、取消和内联校验控件。",
  ],
  [
    "documentation-rule-list.png",
    chinesePlugin ? "消息分发规则" : "Message distribution rules",
    "验证透明规则标题、Add rule 位置、列表无左右间隔、规则名称与笔记路径同行以及快捷操作布局。",
  ],
  [
    "credential-description.png",
    chinesePlugin ? "凭据说明" : "Credential descriptions",
    "验证凭据风险提示位于 Password/Token 设置项内部，且测试值保持为空。",
  ],
  [
    "status-tooltip-columns.png",
    chinesePlugin ? "状态提示两列布局" : "Status tooltip columns",
    "验证状态标题、左侧 label、右侧 value、主题背景与脱敏运行信息。",
  ],
  [
    "rule-modal-layout.png",
    chinesePlugin ? "添加规则弹窗" : "Add rule modal",
    "验证规则名称与 Enabled 同行、Conditions 与 Add condition 同行以及路径搜索控件。",
  ],
  [
    "edit-rule-modal-layout.png",
    chinesePlugin ? "编辑规则弹窗" : "Edit rule modal",
    chinesePlugin
      ? "验证已保存多条件规则重新打开后，中文文案、字段值和布局均保持。"
      : "验证已保存多条件规则重新打开后，英文文案、字段值和布局均保持。",
  ],
  [
    "rules-settings.png",
    chinesePlugin ? "最终规则设置" : "Final rules settings",
    "验证新增、重排、编辑、删除及 reload 后回到原始规则数量，并确认底部只保留插件语言而没有重复 Apply。",
  ],
];
const mimeScreenshots = [
  [
    "mime-rule-editor.png",
    chinesePlugin ? "MIME 规则编辑器" : "MIME rule editor",
    "验证附件 MIME 类型使用带搜索与清空按钮的单行输入控件。",
  ],
  [
    "mime-suggestions-below.png",
    chinesePlugin ? "MIME 建议在输入框下方" : "MIME suggestions below input",
    "验证空间充足时建议列表在输入框下方展开，名称和值保持单行两列。",
  ],
  [
    "mime-suggestions-above.png",
    chinesePlugin ? "MIME 建议在输入框上方" : "MIME suggestions above input",
    "验证弹窗底部空间不足时建议列表自动在输入框上方展开且不越界。",
  ],
  [
    "mime-family-selected.png",
    chinesePlugin ? "已选择 MIME 类型族" : "MIME family selected",
    "验证 startsWith 操作符与 image/ 类型族选择结果。",
  ],
];

await mkdir(matrixRoot, { recursive: true });
await run("npm", ["run", "build"], process.env);

const matrixResults = [];
for (const resolution of resolutions) {
  const label = `${resolution.width}x${resolution.height}`;
  const resolutionRoot = join(matrixRoot, label);
  await rm(resolutionRoot, { recursive: true, force: true });
  await mkdir(resolutionRoot, { recursive: true });
  const commonEnvironment = {
    ...process.env,
    NTFY_UI_ARTIFACT_ROOT: resolutionRoot,
    NTFY_UI_VIEWPORT_WIDTH: String(resolution.width),
    NTFY_UI_VIEWPORT_HEIGHT: String(resolution.height),
  };
  const generalAttempts = await runWithRetry(
    process.execPath,
    ["scripts/ui-acceptance.mjs"],
    {
      ...commonEnvironment,
      NTFY_UI_RUN_ID: "general",
      NTFY_UI_DOC_SCREENSHOTS: "1",
    },
    `${label}/general`,
  );
  const mimeAttempts = await runWithRetry(
    process.execPath,
    ["scripts/mime-ui-acceptance.mjs"],
    {
      ...commonEnvironment,
      NTFY_UI_RUN_ID: "mime",
      NTFY_UI_REVIEW_SCREENSHOTS: "1",
    },
    `${label}/mime`,
  );

  const generalReport = await readJson(join(resolutionRoot, "general", "report.json"));
  const mimeReport = await readJson(join(resolutionRoot, "mime", "report.json"));
  if (!generalReport.passed || !mimeReport.passed) {
    throw new Error(`${label} runner report did not pass`);
  }
  if (
    generalReport.pluginLanguage !== pluginLanguage ||
    mimeReport.pluginLanguage !== pluginLanguage ||
    (hostLanguage &&
      (!generalReport.hostLanguage
        .toLocaleLowerCase()
        .startsWith(hostLanguage.toLocaleLowerCase()) ||
        !mimeReport.hostLanguage.toLocaleLowerCase().startsWith(hostLanguage.toLocaleLowerCase())))
  ) {
    throw new Error(`${label} runner language evidence does not match the requested matrix`);
  }
  const screenshots = [];
  for (const [name, title, description] of generalScreenshots) {
    screenshots.push(
      await inspectScreenshot(
        join(resolutionRoot, "general", name),
        title,
        description,
        resolution,
      ),
    );
  }
  for (const [name, title, description] of mimeScreenshots) {
    screenshots.push(
      await inspectScreenshot(join(resolutionRoot, "mime", name), title, description, resolution),
    );
  }
  assertDistinctScreenshots(screenshots, label);
  const result = {
    resolution: label,
    requested: resolution,
    generalPassed: generalReport.passed,
    mimePassed: mimeReport.passed,
    generalAttempts,
    mimeAttempts,
    generalViewport: generalReport.viewport,
    mimeViewport: mimeReport.viewport,
    screenshots,
  };
  matrixResults.push(result);
  await writeFile(join(resolutionRoot, "REVIEW.md"), reviewMarkdown(result), "utf8");
  await writeFile(join(resolutionRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ matrixId, resolution: label, passed: true })}\n`);
}

const summary = {
  schema: "obsidian.ntfy-sync.ui-resolution-matrix.v1",
  matrixId,
  pluginLanguage,
  hostLanguage,
  generatedAt: new Date().toISOString(),
  resolutions: matrixResults,
  passed: matrixResults.every((result) => result.generalPassed && result.mimePassed),
};
await writeFile(join(matrixRoot, "matrix.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(matrixRoot, "README.md"), indexMarkdown(summary), "utf8");
process.stdout.write(`${JSON.stringify({ matrixId, root: matrixRoot, passed: summary.passed })}\n`);

function parseResolutions(value) {
  if (!value) return defaultResolutions;
  return value.split(",").map((entry) => {
    const match = entry.trim().match(/^(\d+)x(\d+)$/u);
    if (!match) throw new Error(`Invalid resolution: ${entry}`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 1 || height < 1) throw new Error(`Invalid resolution: ${entry}`);
    return { width, height };
  });
}

function run(command, args, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env: environment, stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${basename(command)} exited with ${code ?? signal}`));
    });
  });
}

async function runWithRetry(command, args, environment, label, maxAttempts = 2) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await run(command, args, environment);
      return attempt;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      process.stdout.write(`${JSON.stringify({ label, attempt, retrying: true })}\n`);
    }
  }
  throw new Error(`${label} exhausted its retry budget`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function inspectScreenshot(path, title, description, expected) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error(`Invalid PNG: ${path}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== expected.width || height !== expected.height) {
    throw new Error(
      `Screenshot dimensions differ for ${path}: ${width}x${height}, expected ${expected.width}x${expected.height}`,
    );
  }
  return {
    title,
    description,
    path: relative(matrixRoot, path),
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertDistinctScreenshots(screenshots, resolution) {
  const pathsByHash = new Map();
  for (const screenshot of screenshots) {
    const paths = pathsByHash.get(screenshot.sha256) ?? [];
    paths.push(screenshot.path);
    pathsByHash.set(screenshot.sha256, paths);
  }
  const duplicates = [...pathsByHash.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([sha256, paths]) => ({ sha256, paths }));
  if (duplicates.length > 0) {
    throw new Error(
      `${resolution} contains duplicate review screenshots: ${JSON.stringify(duplicates)}`,
    );
  }
}

function reviewMarkdown(result) {
  const lines = [
    `# ${result.resolution} UI 人工复验`,
    "",
    `- 通用 UI runner：${result.generalPassed ? "PASS" : "FAIL"}`,
    `- MIME UI runner：${result.mimePassed ? "PASS" : "FAIL"}`,
    `- runner 尝试次数：通用 ${result.generalAttempts}，MIME ${result.mimeAttempts}`,
    `- 截图：${result.screenshots.length} 张，均为 ${result.resolution}`,
    `- Obsidian 界面语言：${hostLanguage ?? "未限定"}`,
    `- Ntfy Sync 插件语言：${pluginLanguage}`,
    "",
    "请人工检查文字截断、换行、控件对齐、弹窗边界、下拉列表位置、主题颜色和状态提示信息布局。",
    "",
  ];
  for (const screenshot of result.screenshots) {
    const path = relative(join(matrixRoot, result.resolution), join(matrixRoot, screenshot.path));
    lines.push(
      `## ${screenshot.title}`,
      "",
      `![${screenshot.title}](${path})`,
      "",
      screenshot.description,
      "",
      "> [!note] 人工批注",
      "> 待填写。",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function indexMarkdown(summary) {
  const lines = [
    "# Ntfy Sync 多分辨率 UI 人工复验",
    "",
    `生成时间：${summary.generatedAt}`,
    `Obsidian 界面语言：${summary.hostLanguage ?? "未限定"}`,
    `Ntfy Sync 插件语言：${summary.pluginLanguage}`,
    "",
    "| 分辨率 | 通用 runner | MIME runner | 截图数 | 人工复验 |",
    "| --- | --- | --- | ---: | --- |",
  ];
  for (const result of summary.resolutions) {
    lines.push(
      `| ${result.resolution} | ${result.generalPassed ? "PASS" : "FAIL"} | ${result.mimePassed ? "PASS" : "FAIL"} | ${result.screenshots.length} | [打开](./${result.resolution}/REVIEW.md) |`,
    );
  }
  lines.push(
    "",
    "每个分辨率目录包含 `general/`、`mime/`、两份 runner 报告、截图、`result.json` 和 `REVIEW.md`。截图使用合成配置，runner 结束后恢复测试 Vault 原配置。",
    "",
  );
  return lines.join("\n");
}
