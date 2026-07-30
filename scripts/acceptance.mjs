import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const runId = process.env.NTFY_ACCEPTANCE_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const artifactDirectory = join(".artifacts", "acceptance", runId);
await mkdir(artifactDirectory, { recursive: true });

async function run(command, args, environment = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...environment },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const gates = [];
const verifyCode = await run("npm", ["run", "verify"]);
gates.push({ id: "deterministic", status: verifyCode === 0 ? "passed" : "failed" });
const e2eResults = {};
if (verifyCode === 0) {
  const uiRunId = `${runId}-ui`;
  const uiCode = await run("npm", ["run", "test:ui"], { NTFY_UI_RUN_ID: uiRunId });
  gates.push({ id: "obsidian-settings-ui", status: uiCode === 0 ? "passed" : "failed" });
  for (const transport of ["stream", "poll"]) {
    const e2eRunId = `${runId}-${transport}`;
    const e2eCode = await run("npm", ["run", `test:e2e:${transport}`], {
      NTFY_ACCEPTANCE_RUN_ID: e2eRunId,
    });
    gates.push({
      id: `obsidian-e2e-${transport}`,
      status: e2eCode === 0 ? "passed" : "failed",
    });
    try {
      e2eResults[transport] = JSON.parse(
        await readFile(join(".artifacts", "e2e", e2eRunId, "report.json"), "utf8"),
      );
    } catch {
      e2eResults[transport] = undefined;
    }
  }
} else {
  gates.push({ id: "obsidian-settings-ui", status: "skipped" });
  gates.push({ id: "obsidian-e2e-stream", status: "skipped" });
  gates.push({ id: "obsidian-e2e-poll", status: "skipped" });
}
const report = {
  schema: "obsidian.ntfy-sync.acceptance.v1",
  runId,
  pluginVersion: "0.1.2",
  generatedAt: new Date().toISOString(),
  gates,
  counts: {
    passed: gates.filter((gate) => gate.status === "passed").length,
    failed: gates.filter((gate) => gate.status === "failed").length,
    skipped: gates.filter((gate) => gate.status === "skipped").length,
  },
  e2e: e2eResults,
  passed: gates.every((gate) => gate.status === "passed"),
};
await writeFile(join(artifactDirectory, "report.json"), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report) + "\n");
if (!report.passed) process.exitCode = 1;
