import {
  MarkdownView,
  normalizePath,
  Notice,
  Plugin,
  setIcon,
  setTooltip,
  type App,
} from "obsidian";
import type { PersistedSettingsV1, TransportFault, UiLanguageSetting } from "./domain/types";
import { AttachmentService } from "./effects/attachment";
import { ObsidianVaultPort } from "./effects/vault-port";
import { VaultWriter } from "./effects/vault-writer";
import { DurableInboxService } from "./inbox/durable-inbox";
import { redactObject } from "./shared/redact";
import { JsonStateStore } from "./state/store";
import { migrateSettings } from "./settings/migrate";
import { NtfySyncSettingTab, cloneAuthWithoutSecrets } from "./settings/tab";
import { validateSettings } from "./settings/validate";
import { NtfyConnectionRunner } from "./transport/ntfy/connection";
import { MessageProcessor } from "./app/processor";
import { ResultOutboxService } from "./app/result-outbox";
import { sha256Hex } from "./shared/crypto";
import { buildNtfyStatusView } from "./status/model";
import { registerNtfyStatusIcons } from "./ui/status-icons";
import { createI18n, currentHostLanguage, type I18n } from "./i18n";
import {
  NTFY_MESSAGE_COMPOSER_VIEW,
  NtfyMessageComposerView,
  type MessageComposerPrefill,
} from "./ui/message-composer-view";
import { ComposerSelectionCache } from "./ui/composer-selection-cache";

interface AppWithSettings extends App {
  setting: {
    open(): void;
    openTabById(id: string): void;
  };
}

export default class NtfySyncPlugin extends Plugin {
  override settings: PersistedSettingsV1 = undefined as unknown as PersistedSettingsV1;
  private stateStore?: JsonStateStore;
  private inbox?: DurableInboxService;
  private processor?: MessageProcessor;
  private connections: NtfyConnectionRunner[] = [];
  private runtimeController?: AbortController;
  private statusElement?: HTMLElement;
  private statusTooltipText = "";
  private runtimeError?: string;
  private translator: I18n = createI18n("auto", "en");
  private readonly composerSelectionCache = new ComposerSelectionCache();

  get i18n(): I18n {
    const next = createI18n(this.settings?.uiLanguage ?? "auto", currentHostLanguage());
    if (next.locale !== this.translator.locale) this.translator = next;
    return this.translator;
  }

  override async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.translator = createI18n(this.settings.uiLanguage, currentHostLanguage());
    await this.saveData(this.settings);
    registerNtfyStatusIcons();
    const ownerDocument = this.app.workspace.containerEl.ownerDocument;
    this.registerDomEvent(ownerDocument, "selectionchange", () =>
      this.captureComposerDomSelection(),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.composerSelectionCache.clear()),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.composerSelectionCache.clear()),
    );
    this.registerDomEvent(this.app.workspace.containerEl, "pointerdown", (event) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const target = event.target as Node | null;
      if (view && target && view.containerEl.contains(target)) {
        this.composerSelectionCache.clear();
      }
    });
    this.statusElement = this.addStatusBarItem();
    this.statusElement.addClass("ntfy-sync-status");
    this.statusElement.dataset.testid = "ntfy-sync-status";
    this.statusElement.setAttrs({
      role: "button",
      tabindex: "0",
      "aria-live": "polite",
      "aria-keyshortcuts": "Enter Space",
      "data-tooltip-position": "top",
    });
    const tooltipObserver = new MutationObserver(() => this.structureStatusTooltips());
    tooltipObserver.observe(this.statusElement.ownerDocument.body, {
      childList: true,
      subtree: true,
    });
    this.register(() => tooltipObserver.disconnect());
    this.registerDomEvent(this.statusElement, "dblclick", (event) => {
      event.preventDefault();
      this.openSettings();
    });
    this.registerDomEvent(this.statusElement, "keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openSettings();
    });
    this.addSettingTab(new NtfySyncSettingTab(this.app, this));
    this.registerView(
      NTFY_MESSAGE_COMPOSER_VIEW,
      (leaf) => new NtfyMessageComposerView(leaf, this),
    );
    this.register(() => this.app.workspace.detachLeavesOfType(NTFY_MESSAGE_COMPOSER_VIEW));
    const composerRibbon = this.addRibbonIcon("send", this.i18n.t("ribbon.openComposer"), () => {
      void this.openMessageComposer();
    });
    composerRibbon.addClass("ntfy-sync-open-composer");
    composerRibbon.dataset.testid = "ntfy-open-composer";
    this.addCommand({
      id: "reconnect",
      name: this.i18n.t("command.reconnect"),
      callback: () => void this.restartRuntime(),
    });
    this.addCommand({
      id: "retry-dead-letters",
      name: this.i18n.t("command.retryDeadLetters"),
      callback: async () => {
        const count = (await this.inbox?.retryDeadLetters()) ?? 0;
        this.processor?.wake();
        this.updateStatus();
        new Notice(this.i18n.t("notice.retryQueued", { count }));
      },
    });
    this.addCommand({
      id: "export-diagnostics",
      name: this.i18n.t("command.exportDiagnostics"),
      callback: () => void this.exportDiagnostics(),
    });
    this.addCommand({
      id: "open-message-composer",
      name: this.i18n.t("command.openComposer"),
      callback: () => void this.openMessageComposer(),
    });
    this.addCommand({
      id: "send-selection",
      name: this.i18n.t("command.sendSelection"),
      checkCallback: (checking) => {
        const selection = this.getComposerSelection();
        if (!selection) return false;
        if (!checking) void this.openMessageComposer({ message: selection });
        return true;
      },
    });
    this.addCommand({
      id: "send-current-note-link",
      name: this.i18n.t("command.sendCurrentNoteLink"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          void this.openMessageComposer({
            title: file.basename,
            message: obsidianFileUrl(this.app.vault.getName(), file.path),
          });
        }
        return true;
      },
    });
    this.addCommand({
      id: "send-active-vault-file",
      name: this.i18n.t("command.sendActiveFile"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          void this.openMessageComposer({ title: file.basename, attachmentPath: file.path });
        }
        return true;
      },
    });
    try {
      const pluginDirectory = normalizePath(
        this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      );
      this.stateStore = new JsonStateStore(this.app.vault.adapter, pluginDirectory);
      await this.stateStore.load();
      this.inbox = new DurableInboxService(this.stateStore);
      const vault = new ObsidianVaultPort(this.app);
      const outbox = new ResultOutboxService(this.inbox, () => this.settings.connections);
      this.processor = new MessageProcessor(
        () => this.settings,
        this.inbox,
        new VaultWriter(vault),
        new AttachmentService(vault),
        outbox,
      );
      await this.startRuntime();
    } catch (error) {
      this.runtimeError = error instanceof Error ? error.message : "Initialization failed";
      this.updateStatus();
      new Notice(this.i18n.t("notice.startFailed"));
    }
  }

  override onunload(): void {
    void this.stopRuntime();
  }

  async saveSettings(restart: boolean): Promise<void> {
    await this.saveData(this.settings);
    if (restart) await this.restartRuntime();
  }

  async setUiLanguage(language: UiLanguageSetting): Promise<void> {
    this.settings.uiLanguage = language;
    this.translator = createI18n(language, currentHostLanguage());
    await this.saveData(this.settings);
    this.updateStatus();
    for (const leaf of this.app.workspace.getLeavesOfType(NTFY_MESSAGE_COMPOSER_VIEW)) {
      if (leaf.view instanceof NtfyMessageComposerView) leaf.view.refresh();
    }
  }

  async openMessageComposer(prefill: MessageComposerPrefill = {}): Promise<void> {
    const leaf = await this.app.workspace.ensureSideLeaf(NTFY_MESSAGE_COMPOSER_VIEW, "right", {
      active: true,
      reveal: true,
    });
    await leaf.loadIfDeferred();
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof NtfyMessageComposerView) leaf.view.applyPrefill(prefill);
  }

  private getComposerSelection(): string {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return "";
    const editorSelection = view.getMode() === "source" ? view.editor.getSelection() : "";
    if (editorSelection) return editorSelection;
    const domSelection = this.readComposerDomSelection(view);
    if (domSelection) {
      this.composerSelectionCache.remember(view.file?.path ?? "", domSelection);
      return domSelection;
    }
    return this.composerSelectionCache.recall(view.file?.path ?? "");
  }

  private captureComposerDomSelection(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const selection = this.readComposerDomSelection(view);
    if (selection) {
      this.composerSelectionCache.remember(view.file?.path ?? "", selection);
      return;
    }
    const activeElement = view.containerEl.ownerDocument.activeElement;
    if (activeElement && view.containerEl.contains(activeElement)) {
      this.composerSelectionCache.clear();
    }
  }

  private readComposerDomSelection(view: MarkdownView): string {
    const domSelection = view.containerEl.ownerDocument.getSelection();
    const anchor = domSelection?.anchorNode;
    const focus = domSelection?.focusNode;
    if (
      !domSelection ||
      domSelection.isCollapsed ||
      !anchor ||
      !focus ||
      !view.containerEl.contains(anchor) ||
      !view.containerEl.contains(focus)
    ) {
      return "";
    }
    return domSelection.toString();
  }

  async restartRuntime(): Promise<void> {
    await this.stopRuntime();
    await this.startRuntime();
  }

  getDiagnostics(): Record<string, unknown> {
    const state = this.stateStore?.snapshot();
    return redactObject({
      schema: "obsidian.ntfy-sync.diagnostics.v1",
      pluginVersion: this.manifest.version,
      enabled: this.settings.enabled,
      writer: this.settings.device.deviceId === this.settings.device.writerDeviceId,
      runtimeError: this.runtimeError,
      connections: this.settings.connections.map((connection) => ({
        id: connection.id,
        origin: safeOrigin(connection.baseUrl),
        topicCount: connection.topics.length,
        topicFingerprints: connection.topics.map((topic) => sha256Hex(topic).slice(0, 12)),
        auth: cloneAuthWithoutSecrets(connection.readAuth),
        telemetry: this.connections.find(
          (runner) => runner.telemetry.connectionId === connection.id,
        )?.telemetry,
      })),
      inbox: state
        ? {
            total: Object.keys(state.records).length,
            statusCounts: countStatuses(
              Object.values(state.records).map((record) => record.status),
            ),
            outboxPending: Object.values(state.outbox).filter(
              (record) => record.status === "pending",
            ).length,
            telemetry: state.telemetry,
          }
        : undefined,
    }) as Record<string, unknown>;
  }

  private async startRuntime(): Promise<void> {
    this.runtimeError = undefined;
    if (!this.settings.enabled) {
      this.updateStatus();
      return;
    }
    const issues = validateSettings(this.settings);
    if (issues.length) {
      this.runtimeError = `${issues[0]?.path}: ${issues[0]?.message}`;
      this.updateStatus();
      return;
    }
    if (this.settings.device.deviceId !== this.settings.device.writerDeviceId) {
      this.runtimeError = "monitor-only: writer device mismatch";
      this.updateStatus();
      return;
    }
    if (!this.inbox || !this.processor) return;
    this.runtimeController = new AbortController();
    this.processor.start();
    this.connections = this.settings.connections.map(
      (config) =>
        new NtfyConnectionRunner(
          config,
          this.settings.processing.maxBodyBytes,
          this.settings.processing.overlapSeconds,
          {
            accept: async (message) => {
              const result = await this.inbox!.accept(message);
              await this.inbox!.setWatermark(
                message.source.connectionId,
                message.source.topic,
                message.publishedAtMs,
              );
              if (result === "persisted") this.processor?.wake();
              this.updateStatus();
            },
            ignored: (event) => this.inbox!.countIgnoredEvent(event),
            watermark: () => this.inbox!.watermark(config.id, config.topics),
            fault: (fault) => this.handleFault(config.id, fault),
            statusChanged: (status) => this.handleConnectionStatus(config.id, status),
          },
        ),
    );
    for (const runner of this.connections) runner.start(this.runtimeController.signal);
    this.updateStatus();
  }

  private async stopRuntime(): Promise<void> {
    this.runtimeController?.abort();
    this.processor?.stop();
    const stopping = this.connections.map((runner) => runner.stop());
    this.connections = [];
    await Promise.allSettled(stopping);
    await this.stateStore?.flush();
    this.runtimeController = undefined;
    this.updateStatus();
  }

  private handleFault(connectionId: string, fault: TransportFault): void {
    this.runtimeError = `${connectionId}: ${fault.code}`;
    this.updateStatus();
  }

  private handleConnectionStatus(connectionId: string, status: string): void {
    if (
      (status === "connected" || status === "polling") &&
      this.runtimeError?.startsWith(`${connectionId}:`)
    ) {
      this.runtimeError = undefined;
    }
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.statusElement) return;
    const state = this.stateStore?.snapshot();
    const records = state ? Object.values(state.records) : [];
    const view = buildNtfyStatusView(
      {
        enabled: this.settings.enabled,
        writer: this.settings.device.deviceId === this.settings.device.writerDeviceId,
        runtimeError: this.runtimeError,
        connections: this.connections.map((runner) => runner.telemetry),
        topicCount: this.settings.connections.reduce(
          (sum, connection) => sum + connection.topics.length,
          0,
        ),
        inbox: state
          ? {
              total: records.length,
              pending: records.filter((record) =>
                ["accepted", "planned", "applying", "retry_wait"].includes(record.status),
              ).length,
              deadLetters: records.filter((record) => record.status === "dead_letter").length,
              outboxPending: Object.values(state.outbox).filter(
                (record) => record.status === "pending",
              ).length,
            }
          : undefined,
      },
      this.i18n,
    );
    this.statusElement.empty();
    setIcon(this.statusElement, view.icon);
    this.statusElement.dataset.status = view.state;
    this.statusElement.setAttr("aria-label", view.tooltip);
    this.statusTooltipText = view.tooltip;
    setTooltip(this.statusElement, view.tooltip, {
      placement: "top",
      delay: 200,
      classes: ["ntfy-sync-status-tooltip"],
    });
    this.structureStatusTooltips();
  }

  private structureStatusTooltips(): void {
    if (!this.statusElement || !this.statusTooltipText) return;
    const tooltips = this.statusElement.ownerDocument.querySelectorAll<HTMLElement>(
      ".tooltip.ntfy-sync-status-tooltip",
    );
    for (const tooltip of Array.from(tooltips)) this.structureStatusTooltip(tooltip);
  }

  private structureStatusTooltip(tooltip: HTMLElement): void {
    if (tooltip.dataset.ntfyStructured === this.statusTooltipText) return;
    const arrow = tooltip.querySelector<HTMLElement>(".tooltip-arrow");
    for (const node of Array.from(tooltip.childNodes)) {
      if (node !== arrow) node.remove();
    }

    const [titleText = "Ntfy Sync", ...lines] = this.statusTooltipText.split("\n");
    const title = tooltip.createDiv({
      cls: "ntfy-sync-status-tooltip-title",
      text: titleText,
    });
    tooltip.insertBefore(title, arrow);

    const grid = tooltip.createDiv({ cls: "ntfy-sync-status-tooltip-grid" });
    for (const line of lines) {
      const separator = line.indexOf(": ");
      const row = grid.createDiv({ cls: "ntfy-sync-status-tooltip-row" });
      row.createSpan({
        cls: "ntfy-sync-status-tooltip-label",
        text: separator >= 0 ? line.slice(0, separator) : line,
      });
      row.createSpan({
        cls: "ntfy-sync-status-tooltip-value",
        text: separator >= 0 ? line.slice(separator + 2) : "",
      });
    }
    tooltip.insertBefore(grid, arrow);
    tooltip.dataset.ntfyStructured = this.statusTooltipText;
  }

  openSettings(): void {
    const settings = (this.app as AppWithSettings).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  private async exportDiagnostics(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `Obsidian/ntfy/diagnostics-${timestamp}.json`;
    const vault = new ObsidianVaultPort(this.app);
    await vault.writeText(path, JSON.stringify(this.getDiagnostics(), null, 2));
    new Notice(this.i18n.t("notice.diagnosticsWritten", { path }));
  }
}

function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "<invalid-origin>";
  }
}

function countStatuses(statuses: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

function obsidianFileUrl(vaultName: string, filePath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
}
