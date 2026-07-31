import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { installTestVault } from "./install-test-vault.mjs";

const exec = promisify(execFile);
const runId = process.env.NTFY_ACCEPTANCE_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const topic = `ntfy-sync-e2e-${randomBytes(10).toString("hex")}`;
const resultTopic = `${topic}-result`;
const transportMode = process.env.NTFY_E2E_TRANSPORT === "poll" ? "poll" : "stream";
const messageId = randomBytes(5).toString("base64url").padEnd(10, "A").slice(0, 10);
const attachmentBody = Buffer.from(`ntfy-sync attachment ${runId}\n`, "utf8");
const expectedAttachmentSha256 = createHash("sha256").update(attachmentBody).digest("hex");
const artifactDirectory = join(".artifacts", "e2e", runId);
await mkdir(artifactDirectory, { recursive: true });

const clients = new Set();
const publishedResults = [];
let pendingEvent;
let pollRequests = 0;
let streamRequests = 0;
let serverOrigin = "";
const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
    });
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/e2e-attachment") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": String(attachmentBody.byteLength),
      "access-control-allow-origin": "*",
    });
    response.end(attachmentBody);
    return;
  }
  if (request.method === "GET" && request.url?.includes("/json")) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.searchParams.get("poll") === "1") {
      pollRequests += 1;
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "access-control-allow-origin": "*",
      });
      response.write(
        JSON.stringify({
          event: "open",
          time: Math.floor(Date.now() / 1000),
          topic,
        }) + "\n",
      );
      if (pendingEvent) {
        response.write(`${pendingEvent}\n`);
        pendingEvent = undefined;
      }
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    response.write(
      JSON.stringify({
        event: "open",
        time: Math.floor(Date.now() / 1000),
        topic,
      }) + "\n",
    );
    streamRequests += 1;
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    try {
      publishedResults.push(JSON.parse(raw));
    } catch {
      // The assertion below reports malformed result payloads without echoing content.
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    response.end(
      JSON.stringify({
        id: randomBytes(5).toString("base64url"),
        time: 1,
        event: "message",
        topic: resultTopic,
      }),
    );
    return;
  }
  response.writeHead(404).end();
});

function publishMessage(body, includeAttachment = false) {
  const event = JSON.stringify({
    event: "message",
    id: messageId,
    time: Math.floor(Date.now() / 1000),
    topic,
    message: body,
    attachment: includeAttachment
      ? {
          name: "e2e.txt",
          url: `${serverOrigin}/e2e-attachment`,
          type: "text/plain",
          size: attachmentBody.byteLength,
        }
      : undefined,
  });
  pendingEvent = event;
  for (const client of clients) client.write(`${event}\n`);
}

async function obsidian(vaultName, ...args) {
  const { stdout, stderr } = await exec("obsidian", [`vault=${vaultName}`, ...args], {
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

async function obsidianEvalJson(vaultName, code) {
  const output = await obsidian(vaultName, "eval", `code=${code}`);
  const match = output.match(/=>\s*(\{.*\})\s*$/s);
  if (!match) throw new Error("Obsidian eval returned no JSON object");
  return JSON.parse(match[1]);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let vault;
let vaultName;
let pluginDirectory;
let dataBackup;
let dataExisted = false;
let dataPath;
let stateBackup;
let stateExisted = false;
let statePath;
let stateFileBackup;
let stateFileBackupExisted = false;
let stateBackupPath;
let targetPath;
let absoluteTarget;
let attachmentPath;
let absoluteAttachment;
let baselineErrors = "";
const checks = {};

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  serverOrigin = `http://127.0.0.1:${port}`;
  ({ vault, destination: pluginDirectory } = await installTestVault());
  vaultName = basename(vault);
  dataPath = join(pluginDirectory, "data.json");
  statePath = join(pluginDirectory, "state-v1.json");
  stateBackupPath = join(pluginDirectory, "state-v1.backup.json");
  try {
    dataBackup = await readFile(dataPath);
    dataExisted = true;
  } catch {
    dataBackup = undefined;
  }
  try {
    stateBackup = await readFile(statePath);
    stateExisted = true;
  } catch {
    stateBackup = undefined;
  }
  try {
    stateFileBackup = await readFile(stateBackupPath);
    stateFileBackupExisted = true;
  } catch {
    stateFileBackup = undefined;
  }
  baselineErrors = await obsidian(vaultName, "dev:errors");
  await obsidian(vaultName, "plugin:enable", "id=ntfy-sync");
  targetPath = `Obsidian/ntfy-e2e/${runId}.md`;
  const configurationCode = `
    (async () => {
      const p = app.plugins.plugins["ntfy-sync"];
      if (!p) throw new Error("plugin not loaded");
      p.settings.enabled = true;
      p.settings.connections = [{
        id: "e2e",
        name: "E2E",
        baseUrl: ${JSON.stringify(serverOrigin)},
        topics: [${JSON.stringify(topic)}],
        readAuth: { kind: "none" },
        result: {
          topic: ${JSON.stringify(resultTopic)},
          writeAuth: { kind: "none" },
          privacy: "minimal",
          cache: false
        },
        mode: ${JSON.stringify(transportMode)},
        pollIntervalSeconds: 1,
        allowInsecureHttp: true,
        initialReplay: { kind: "latest" },
        reconnect: { minMs: 50, maxMs: 250, jitterRatio: 1 }
      }];
      const fallback = p.settings.rules.rules.find((rule) => rule.id === "inbox");
      fallback.action.notePathTemplate = ${JSON.stringify(targetPath)};
      fallback.action.insertion = "append";
      p.settings.processing.overlapSeconds = 2;
      await p.saveSettings(true);
      return JSON.stringify({configured: true});
    })()
  `;
  await obsidian(vaultName, "eval", `code=${configurationCode}`);
  await waitFor(
    () => (transportMode === "stream" ? clients.size === 1 : pollRequests >= 1),
    5_000,
    `${transportMode} connection`,
  );
  checks.transport = transportMode;
  checks.transportConnected = true;
  const statusIndicator = await obsidianEvalJson(
    vaultName,
    `(() => {
      const element = document.querySelector('[data-testid="ntfy-sync-status"]');
      return JSON.stringify({
        state: element?.dataset.status,
        icon: Boolean(element?.querySelector("svg")),
        tooltip: element?.getAttribute("aria-label") ?? ""
      });
    })()`,
  );
  checks.statusIndicator =
    statusIndicator.state === (transportMode === "stream" ? "connected" : "polling") &&
    statusIndicator.icon &&
    statusIndicator.tooltip.startsWith("Ntfy Sync — ");
  if (!checks.statusIndicator) throw new Error("Status indicator did not reflect transport state");

  absoluteTarget = join(vault, targetPath);
  attachmentPath = `Obsidian/ntfy/attachments/e2e.txt-${messageId}`;
  absoluteAttachment = join(vault, attachmentPath);
  await waitFor(
    async () => {
      publishMessage(`first-version-e2e ${runId}`, true);
      try {
        return (await readFile(absoluteTarget, "utf8")).includes("ntfy-sync:v1");
      } catch {
        return false;
      }
    },
    8_000,
    "Vault marker",
  );
  checks.noteWritten = true;
  await waitFor(
    async () => {
      try {
        const bytes = await readFile(absoluteAttachment);
        return createHash("sha256").update(bytes).digest("hex") === expectedAttachmentSha256;
      } catch {
        return false;
      }
    },
    5_000,
    "attachment hash",
  );
  checks.attachmentHashVerified = true;
  await waitFor(() => publishedResults.length >= 1, 5_000, "result outbox");
  const resultEnvelope = JSON.parse(publishedResults[0]?.message ?? "{}");
  checks.resultMinimal =
    resultEnvelope.schema === "obsidian.ntfy-sync.result.v1" &&
    resultEnvelope.outcome === "succeeded" &&
    resultEnvelope.targets === undefined;
  if (!checks.resultMinimal) throw new Error("Result payload was not privacy-minimal");

  const stateRaw = JSON.parse(await readFile(join(pluginDirectory, "state-v1.json"), "utf8"));
  const persistedRecord = Object.values(stateRaw.payload.records).find(
    (record) => record.message.source.messageId === messageId,
  );
  checks.statePersistedBeforeCompletion =
    stateRaw.schemaVersion === 1 &&
    typeof stateRaw.checksum === "string" &&
    persistedRecord?.status === "complete" &&
    persistedRecord.receipt?.attachmentPath === attachmentPath &&
    persistedRecord.receipt?.attachmentSha256 === expectedAttachmentSha256;
  if (!checks.statePersistedBeforeCompletion) {
    throw new Error("Durable completion evidence missing");
  }

  const requestsBeforeReload = transportMode === "stream" ? streamRequests : pollRequests;
  await obsidian(vaultName, "plugin:reload", "id=ntfy-sync");
  await waitFor(
    () =>
      transportMode === "stream"
        ? streamRequests > requestsBeforeReload && clients.size === 1
        : pollRequests > requestsBeforeReload,
    5_000,
    `${transportMode} reconnect after reload`,
  );
  checks.reloadedAndReconnected = true;

  publishMessage(`duplicate ${runId}`, true);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const content = await readFile(absoluteTarget, "utf8");
  checks.markerCount = content.match(/ntfy-sync:v1/g)?.length ?? 0;
  if (checks.markerCount !== 1) throw new Error("Duplicate delivery created duplicate markers");

  await obsidian(vaultName, "plugin:disable", "id=ntfy-sync");
  const pollsAfterDisable = pollRequests;
  if (transportMode === "stream") {
    await waitFor(() => clients.size === 0, 5_000, "stream shutdown");
    checks.shutdownUnderFiveSeconds = true;
  } else {
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    checks.shutdownUnderFiveSeconds = pollRequests === pollsAfterDisable;
  }
  if (!checks.shutdownUnderFiveSeconds) {
    throw new Error("Polling continued after plugin disable");
  }
  checks.rollbackPreservedContent = (await stat(absoluteTarget)).isFile();
  if (!checks.rollbackPreservedContent) throw new Error("Rollback removed Vault content");

  const afterErrors = await obsidian(vaultName, "dev:errors");
  checks.noNewObsidianErrors = afterErrors === baselineErrors;
  if (!checks.noNewObsidianErrors) {
    throw new Error("Obsidian dev:errors changed during plugin E2E");
  }

  const report = {
    schema: "obsidian.ntfy-sync.e2e.v1",
    runId,
    pluginVersion: "0.1.4",
    vault: vaultName,
    checks,
    evidence: { attachmentSha256: expectedAttachmentSha256 },
    passed: Object.values(checks).every(Boolean),
  };
  await writeFile(join(artifactDirectory, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + "\n");
} catch (error) {
  let diagnostics;
  if (vaultName) {
    try {
      const raw = await obsidian(
        vaultName,
        "eval",
        'code=JSON.stringify(app.plugins.plugins["ntfy-sync"]?.getDiagnostics?.())',
      );
      const match = raw.match(/=>\s*(\{.*\})\s*$/s);
      diagnostics = match ? JSON.parse(match[1]) : undefined;
    } catch {
      diagnostics = undefined;
    }
  }
  const report = {
    schema: "obsidian.ntfy-sync.e2e.v1",
    runId,
    checks,
    harness: {
      pollRequests,
      streamRequests,
      streamClients: clients.size,
      resultPublishes: publishedResults.length,
    },
    diagnostics,
    passed: false,
    error: error instanceof Error ? error.message : "E2E failed",
  };
  await writeFile(join(artifactDirectory, "report.json"), JSON.stringify(report, null, 2));
  process.stderr.write(JSON.stringify(report) + "\n");
  process.exitCode = 1;
} finally {
  for (const client of clients) client.destroy();
  await new Promise((resolve) => server.close(resolve));
  if (vaultName) {
    await obsidian(vaultName, "plugin:disable", "id=ntfy-sync").catch(() => undefined);
  }
  if (absoluteTarget) await unlink(absoluteTarget).catch(() => undefined);
  if (absoluteAttachment) await unlink(absoluteAttachment).catch(() => undefined);
  if (dataPath) {
    if (dataExisted && dataBackup) await writeFile(dataPath, dataBackup);
    else await unlink(dataPath).catch(() => undefined);
  }
  if (statePath) {
    if (stateExisted && stateBackup) await writeFile(statePath, stateBackup);
    else await unlink(statePath).catch(() => undefined);
  }
  if (stateBackupPath) {
    if (stateFileBackupExisted && stateFileBackup) {
      await writeFile(stateBackupPath, stateFileBackup);
    } else {
      await unlink(stateBackupPath).catch(() => undefined);
    }
  }
}
