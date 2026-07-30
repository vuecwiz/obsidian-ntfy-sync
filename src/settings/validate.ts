import { normalizeVaultPath } from "../effects/paths";
import { validateRuleSet, type ValidationIssue } from "../rules/engine";
import { validateTemplate } from "../templates/engine";
import { canonicalServerOrigin } from "../transport/ntfy/normalizer";

const NTFY_TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidNtfyTopic(value: unknown): value is string {
  return typeof value === "string" && NTFY_TOPIC_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export function validateSettings(settings: unknown): ValidationIssue[] {
  if (!isRecord(settings)) return [issue("settings", "TYPE", "Settings must be an object")];
  const issues: ValidationIssue[] = [];
  if (settings.schemaVersion !== 1) {
    issues.push(issue("schemaVersion", "SCHEMA", "Expected schemaVersion 1"));
  }
  if (!["auto", "en", "zh-CN"].includes(String(settings.uiLanguage))) {
    issues.push(issue("uiLanguage", "LANGUAGE", "Invalid plugin interface language"));
  }
  if (typeof settings.enabled !== "boolean") {
    issues.push(issue("enabled", "TYPE", "enabled must be boolean"));
  }
  validateDevice(settings.device, issues);

  const templateEntries = templateEntriesFrom(settings.templates, issues);
  issues.push(...validateRuleSet(settings.rules, new Set(Object.keys(templateEntries))));
  for (const [id, template] of Object.entries(templateEntries)) {
    for (const message of validateTemplate(template)) {
      issues.push(issue(`templates.${id}`, "TEMPLATE", message));
    }
  }

  const connections = Array.isArray(settings.connections) ? settings.connections : [];
  if (!Array.isArray(settings.connections)) {
    issues.push(issue("connections", "TYPE", "connections must be an array"));
  }
  const connectionIds = new Set<string>();
  connections.forEach((connection, index) =>
    validateConnection(connection, index, connectionIds, issues),
  );
  validateProcessing(settings.processing, issues);
  validateDiagnostics(settings.diagnostics, issues);
  validateRulePaths(settings.rules, issues);
  return issues;
}

function templateEntriesFrom(
  templates: unknown,
  issues: ValidationIssue[],
): Record<string, string> {
  if (!isRecord(templates) || templates.schemaVersion !== 1 || !isRecord(templates.entries)) {
    issues.push(issue("templates", "TYPE", "TemplateCatalog V1 is required"));
    return {};
  }
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(templates.entries)) {
    if (!id || typeof value !== "string") {
      issues.push(issue(`templates.${id || "<empty>"}`, "TYPE", "Template must be a string"));
    } else {
      result[id] = value;
    }
  }
  return result;
}

function validateDevice(value: unknown, issues: ValidationIssue[]): void {
  if (
    !isRecord(value) ||
    typeof value.deviceId !== "string" ||
    !value.deviceId ||
    typeof value.writerDeviceId !== "string" ||
    !value.writerDeviceId
  ) {
    issues.push(issue("device", "DEVICE", "deviceId and writerDeviceId are required"));
  }
}

function validateConnection(
  value: unknown,
  index: number,
  connectionIds: Set<string>,
  issues: ValidationIssue[],
): void {
  const path = `connections[${index}]`;
  if (!isRecord(value)) {
    issues.push(issue(path, "TYPE", "Connection must be an object"));
    return;
  }
  const id = typeof value.id === "string" ? value.id : "";
  if (!id || !/^[a-z0-9_-]+$/i.test(id)) {
    issues.push(issue(`${path}.id`, "ID", "Invalid connection ID"));
  }
  if (connectionIds.has(id)) {
    issues.push(issue(`${path}.id`, "DUPLICATE", "Duplicate connection ID"));
  }
  connectionIds.add(id);
  if (typeof value.name !== "string" || !value.name.trim()) {
    issues.push(issue(`${path}.name`, "NAME", "Connection name is required"));
  }
  if (typeof value.baseUrl !== "string") {
    issues.push(issue(`${path}.baseUrl`, "BASE_URL", "Server URL is required"));
  } else {
    try {
      canonicalServerOrigin(value.baseUrl, value.allowInsecureHttp === true);
    } catch (error) {
      issues.push(
        issue(
          `${path}.baseUrl`,
          "BASE_URL",
          error instanceof Error ? error.message : "Invalid server URL",
        ),
      );
    }
  }
  if (typeof value.allowInsecureHttp !== "boolean") {
    issues.push(issue(`${path}.allowInsecureHttp`, "TYPE", "allowInsecureHttp must be boolean"));
  }
  const topics = Array.isArray(value.topics) ? value.topics : [];
  if (
    !Array.isArray(value.topics) ||
    !topics.length ||
    topics.some((topic) => !isValidNtfyTopic(topic))
  ) {
    issues.push(
      issue(
        `${path}.topics`,
        "TOPICS",
        "Topics must be 1-64 characters using only letters, numbers, underscores, and dashes",
      ),
    );
  }
  validateAuth(value.readAuth, `${path}.readAuth`, issues);
  validateResult(value.result, topics, path, issues);
  if (!(["auto", "stream", "poll"] as const).includes(value.mode as never)) {
    issues.push(issue(`${path}.mode`, "MODE", "Invalid transport mode"));
  }
  if (!positiveNumber(value.pollIntervalSeconds)) {
    issues.push(issue(`${path}.pollIntervalSeconds`, "RANGE", "Poll interval must be positive"));
  }
  validateReplay(value.initialReplay, path, issues);
  validateReconnect(value.reconnect, path, issues);
}

function validateAuth(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value) || !(["none", "basic", "bearer"] as const).includes(value.kind as never)) {
    issues.push(issue(path, "AUTH", "Invalid authentication mode"));
    return;
  }
  if (
    value.kind === "basic" &&
    (typeof value.username !== "string" ||
      !value.username ||
      typeof value.password !== "string" ||
      !value.password)
  ) {
    issues.push(issue(path, "AUTH", "Username and password are required"));
  }
  if (value.kind === "bearer" && (typeof value.token !== "string" || !value.token)) {
    issues.push(issue(path, "AUTH", "Token is required"));
  }
}

function validateResult(
  value: unknown,
  topics: unknown[],
  connectionPath: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return;
  const path = `${connectionPath}.result`;
  if (!isRecord(value)) {
    issues.push(issue(path, "TYPE", "Result configuration must be an object"));
    return;
  }
  if (!isValidNtfyTopic(value.topic)) {
    issues.push(
      issue(
        `${path}.topic`,
        "RESULT_TOPIC",
        "Result topic must be 1-64 characters using only letters, numbers, underscores, and dashes",
      ),
    );
  } else if (topics.includes(value.topic)) {
    issues.push(
      issue(`${path}.topic`, "RESULT_TOPIC", "Result topic must be separate from input topics"),
    );
  }
  if (!(["minimal", "paths"] as const).includes(value.privacy as never)) {
    issues.push(issue(`${path}.privacy`, "PRIVACY", "Invalid result privacy mode"));
  }
  if (typeof value.cache !== "boolean") {
    issues.push(issue(`${path}.cache`, "TYPE", "Result cache must be boolean"));
  }
  validateAuth(value.writeAuth, `${path}.writeAuth`, issues);
}

function validateReplay(value: unknown, connectionPath: string, issues: ValidationIssue[]): void {
  const path = `${connectionPath}.initialReplay`;
  if (!isRecord(value) || !(["latest", "duration", "all"] as const).includes(value.kind as never)) {
    issues.push(issue(path, "REPLAY", "Invalid initial replay mode"));
    return;
  }
  if (value.kind === "duration" && !positiveNumber(value.valueSeconds)) {
    issues.push(issue(`${path}.valueSeconds`, "RANGE", "Replay duration must be positive"));
  }
}

function validateReconnect(
  value: unknown,
  connectionPath: string,
  issues: ValidationIssue[],
): void {
  const path = `${connectionPath}.reconnect`;
  if (!isRecord(value)) {
    issues.push(issue(path, "TYPE", "Reconnect configuration is required"));
    return;
  }
  if (!positiveNumber(value.minMs) || !positiveNumber(value.maxMs) || value.maxMs < value.minMs) {
    issues.push(issue(path, "RANGE", "Reconnect bounds are invalid"));
  }
  if (
    typeof value.jitterRatio !== "number" ||
    !Number.isFinite(value.jitterRatio) ||
    value.jitterRatio < 0 ||
    value.jitterRatio > 1
  ) {
    issues.push(issue(`${path}.jitterRatio`, "RANGE", "Jitter ratio must be between 0 and 1"));
  }
}

function validateProcessing(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("processing", "TYPE", "Processing configuration is required"));
    return;
  }
  const nonNegative = ["overlapSeconds"];
  const positive = [
    "maxBodyBytes",
    "maxAttachmentBytes",
    "maxAttempts",
    "concurrency",
    "completedRetentionDays",
    "completedRetentionCount",
  ];
  for (const field of nonNegative) {
    if (!nonNegativeNumber(value[field])) {
      issues.push(issue(`processing.${field}`, "RANGE", `${field} must be non-negative`));
    }
  }
  for (const field of positive) {
    if (!positiveNumber(value[field])) {
      issues.push(issue(`processing.${field}`, "RANGE", `${field} must be positive`));
    }
  }
  if (typeof value.downloadSameOriginAttachments !== "boolean") {
    issues.push(
      issue(
        "processing.downloadSameOriginAttachments",
        "TYPE",
        "downloadSameOriginAttachments must be boolean",
      ),
    );
  }
}

function validateDiagnostics(value: unknown, issues: ValidationIssue[]): void {
  if (
    !isRecord(value) ||
    !(["error", "info", "debug"] as const).includes(value.logLevel as never) ||
    typeof value.redactBodies !== "boolean"
  ) {
    issues.push(issue("diagnostics", "TYPE", "Invalid diagnostics configuration"));
  }
}

function validateRulePaths(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value) || !Array.isArray(value.rules)) return;
  value.rules.forEach((rule, index) => {
    if (!isRecord(rule) || !isRecord(rule.action)) return;
    const notePath = rule.action.notePathTemplate;
    if (typeof notePath === "string") {
      validatePathTemplate(notePath, `rules[${index}].action.notePathTemplate`, true, issues);
    }
    const attachmentPath = rule.action.attachmentPathTemplate;
    if (typeof attachmentPath === "string") {
      validatePathTemplate(
        attachmentPath,
        `rules[${index}].action.attachmentPathTemplate`,
        false,
        issues,
      );
    }
  });
}

function validatePathTemplate(
  template: string,
  path: string,
  requireMarkdown: boolean,
  issues: ValidationIssue[],
): void {
  try {
    normalizeVaultPath(template.replace(/{{[^{}]+}}/g, "safe"), { requireMarkdown });
  } catch (error) {
    issues.push(
      issue(path, "PATH", error instanceof Error ? error.message : "Invalid path template"),
    );
  }
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
