import {
  AbstractInputSuggest,
  ExtraButtonComponent,
  ItemView,
  Notice,
  Setting,
  TFile,
  ToggleComponent,
  type App,
  type SearchComponent,
  type WorkspaceLeaf,
} from "obsidian";
import { publishConfiguredMessage, TestPublishValidationError } from "../app/test-publisher";
import type { ConnectionConfigV1 } from "../domain/types";
import type NtfySyncPlugin from "../main";
import { localizeValidationIssue, type I18n, type TranslationKey } from "../i18n";

export const NTFY_MESSAGE_COMPOSER_VIEW = "ntfy-sync-message-composer";

export interface MessageComposerPrefill {
  topic?: string;
  title?: string;
  message?: string;
  attachmentPath?: string;
}

interface MessageComposerDraft {
  baseUrl: string;
  topic: string;
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tagsText: string;
  attachmentPath: string;
  markdown: boolean;
  clickUrl: string;
  email: string;
  delay: string;
  attachmentUrl: string;
  filename: string;
}

type OptionalComposerField = "priority" | "clickUrl" | "email" | "delay" | "attachmentUrl";

class ComposerConnectionSuggest extends AbstractInputSuggest<ConnectionConfigV1> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
    private readonly connections: () => ConnectionConfigV1[],
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  protected getSuggestions(query: string): ConnectionConfigV1[] {
    const normalized = query.trim().toLocaleLowerCase();
    return this.connections().filter((connection) =>
      `${connection.name} ${connection.baseUrl}`.toLocaleLowerCase().includes(normalized),
    );
  }

  renderSuggestion(connection: ConnectionConfigV1, el: HTMLElement): void {
    el.dataset.testid = "ntfy-composer-connection-suggestion";
    el.createDiv({ text: connection.name });
    el.createEl("small", { text: connectionOrigin(connection.baseUrl) });
  }

  override selectSuggestion(connection: ConnectionConfigV1): void {
    this.inputEl.value = connection.baseUrl;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}

class ComposerTopicSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
    private readonly topics: () => string[],
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  protected getSuggestions(query: string): string[] {
    const normalized = query.trim().toLocaleLowerCase();
    return this.topics().filter((topic) => topic.toLocaleLowerCase().includes(normalized));
  }

  renderSuggestion(topic: string, el: HTMLElement): void {
    el.dataset.testid = "ntfy-composer-topic-suggestion";
    el.setText(topic);
  }

  override selectSuggestion(topic: string): void {
    this.inputEl.value = topic;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}

class ComposerFileSuggest extends AbstractInputSuggest<TFile> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
    private readonly files: () => TFile[],
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  protected getSuggestions(query: string): TFile[] {
    const normalized = query.trim().toLocaleLowerCase();
    return this.files()
      .filter((file) => file.path.toLocaleLowerCase().includes(normalized))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, this.limit);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.dataset.testid = "ntfy-composer-file-suggestion";
    el.setText(file.path);
  }

  override selectSuggestion(file: TFile): void {
    this.inputEl.value = file.path;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}

export class NtfyMessageComposerView extends ItemView {
  private draft: MessageComposerDraft;
  private connectionSuggester?: ComposerConnectionSuggest;
  private topicSuggester?: ComposerTopicSuggest;
  private fileSuggester?: ComposerFileSuggest;
  private validationEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private submitButton?: HTMLButtonElement;
  private publishing = false;
  private publishController?: AbortController;
  private outsideClickCleanup?: () => void;
  private moreOptionsPortalCleanup?: () => void;
  private footerInsetCleanup?: () => void;
  private readonly optionalFields = new Set<OptionalComposerField>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: NtfySyncPlugin,
  ) {
    super(leaf);
    this.draft = this.newDraft();
  }

  getViewType(): string {
    return NTFY_MESSAGE_COMPOSER_VIEW;
  }

  getDisplayText(): string {
    return this.plugin.i18n.t("composer.title");
  }

  override getIcon(): string {
    return "send";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("ntfy-sync-composer");
    this.contentEl.dataset.testid = "ntfy-message-composer";
    this.addAction("rotate-ccw", this.plugin.i18n.t("composer.clear"), () => this.clearDraft());
    this.render();
    this.installFooterInsetTracking();
  }

  override async onClose(): Promise<void> {
    this.publishController?.abort();
    this.outsideClickCleanup?.();
    this.outsideClickCleanup = undefined;
    this.moreOptionsPortalCleanup?.();
    this.moreOptionsPortalCleanup = undefined;
    this.footerInsetCleanup?.();
    this.footerInsetCleanup = undefined;
    this.closeSuggesters();
    this.contentEl.empty();
  }

  applyPrefill(prefill: MessageComposerPrefill): void {
    if (prefill.topic !== undefined) this.draft.topic = prefill.topic;
    if (prefill.title !== undefined) this.draft.title = prefill.title;
    if (prefill.message !== undefined) this.draft.message = prefill.message;
    if (prefill.attachmentPath !== undefined) {
      this.draft.attachmentPath = prefill.attachmentPath;
      if (prefill.attachmentPath) {
        this.draft.attachmentUrl = "";
        this.draft.filename = "";
      }
    }
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private newDraft(): MessageComposerDraft {
    return {
      baseUrl: this.plugin.settings.connections[0]?.baseUrl ?? "",
      topic: this.plugin.settings.connections[0]?.topics[0] ?? "",
      title: "",
      message: "",
      priority: undefined,
      tagsText: "",
      attachmentPath: "",
      markdown: false,
      clickUrl: "",
      email: "",
      delay: "",
      attachmentUrl: "",
      filename: "",
    };
  }

  private clearDraft(): void {
    if (this.publishing) return;
    this.draft.title = "";
    this.draft.message = "";
    this.draft.tagsText = "";
    this.draft.attachmentPath = "";
    this.draft.clickUrl = "";
    this.draft.email = "";
    this.draft.delay = "";
    this.draft.attachmentUrl = "";
    this.draft.filename = "";
    for (const testId of [
      "ntfy-composer-title",
      "ntfy-composer-message",
      "ntfy-composer-file",
      "ntfy-composer-tags",
      "ntfy-composer-click-url",
      "ntfy-composer-email",
      "ntfy-composer-attachment-url",
      "ntfy-composer-filename",
      "ntfy-composer-delay",
    ]) {
      const input = this.contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-testid="${testId}"]`,
      );
      if (!input) continue;
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    this.clearFeedback();
  }

  private render(): void {
    if (!this.contentEl.isConnected) return;
    const i18n = this.plugin.i18n;
    const t: I18n["t"] = (key, variables) => i18n.t(key, variables);
    this.outsideClickCleanup?.();
    this.outsideClickCleanup = undefined;
    this.moreOptionsPortalCleanup?.();
    this.moreOptionsPortalCleanup = undefined;
    this.closeSuggesters();
    this.contentEl.empty();
    this.contentEl.dataset.locale = i18n.locale;

    const header = this.contentEl.createDiv({ cls: "ntfy-sync-composer-heading" });
    const headerText = header.createDiv({ cls: "ntfy-sync-composer-heading-text" });
    const title = headerText.createDiv({
      cls: "ntfy-sync-composer-title",
      text: t("composer.title"),
    });
    title.dataset.testid = "ntfy-composer-heading-title";
    const settingsButton = new ExtraButtonComponent(header);
    settingsButton.extraSettingsEl.dataset.testid = "ntfy-composer-open-settings";
    settingsButton
      .setIcon("settings")
      .setTooltip(t("composer.openSettings"))
      .onClick(() => this.plugin.openSettings());
    const form = this.contentEl.createDiv({ cls: "ntfy-sync-composer-form" });

    new Setting(form)
      .setName(t("composer.connection"))
      .setClass("ntfy-sync-composer-connection")
      .setClass("ntfy-sync-composer-destination")
      .setClass("ntfy-sync-composer-inline")
      .addSearch((search) => {
        this.configureConnectionSearch(search, t("composer.connectionPlaceholder"));
      });

    new Setting(form)
      .setName(t("composer.topic"))
      .setClass("ntfy-sync-composer-destination")
      .setClass("ntfy-sync-composer-inline")
      .addSearch((search) => {
        this.configureTopicSearch(search, t("composer.topicPlaceholder"));
      });

    new Setting(form)
      .setName(t("composer.titleField"))
      .setClass("ntfy-sync-composer-destination")
      .setClass("ntfy-sync-composer-inline")
      .addText((text) => {
        text.inputEl.dataset.testid = "ntfy-composer-title";
        text
          .setPlaceholder(t("composer.titlePlaceholder"))
          .setValue(this.draft.title)
          .onChange((value) => {
            this.draft.title = value;
            this.clearFeedback();
          });
      });

    const messageSetting = new Setting(form)
      .setName(t("composer.message"))
      .setClass("ntfy-sync-composer-message");
    const markdownControl = messageSetting.infoEl.createDiv({
      cls: "ntfy-sync-composer-markdown-control",
    });
    markdownControl.createSpan({ text: t("composer.markdown") });
    const markdownToggle = new ToggleComponent(markdownControl);
    markdownToggle.toggleEl.dataset.testid = "ntfy-composer-markdown";
    markdownToggle.setValue(this.draft.markdown).onChange((value) => {
      this.draft.markdown = value;
      this.clearFeedback();
    });
    messageSetting.addTextArea((textarea) => {
      textarea.inputEl.dataset.testid = "ntfy-composer-message";
      textarea.inputEl.rows = 8;
      textarea
        .setPlaceholder(t("composer.messagePlaceholder"))
        .setValue(this.draft.message)
        .onChange((value) => {
          this.draft.message = value;
          this.clearFeedback();
        });
      textarea.inputEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
        event.preventDefault();
        void this.publish();
      });
    });

    new Setting(form)
      .setName(t("composer.file"))
      .setClass("ntfy-sync-composer-compact-inline")
      .setClass("ntfy-sync-composer-file-row")
      .setClass("ntfy-sync-composer-inline")
      .addSearch((search) => {
        this.configureFileSearch(search, t("composer.filePlaceholder"));
      });

    const tagsSetting = new Setting(form)
      .setName(t("composer.tags"))
      .setClass("ntfy-sync-composer-tags");
    tagsSetting.infoEl.createSpan({
      cls: "ntfy-sync-composer-tags-description",
      text: t("composer.tagsDesc"),
    });
    tagsSetting.addText((text) => {
      text.inputEl.dataset.testid = "ntfy-composer-tags";
      text
        .setPlaceholder(t("composer.tagsPlaceholder"))
        .setValue(this.draft.tagsText)
        .onChange((value) => {
          this.draft.tagsText = value;
          this.clearFeedback();
        });
    });

    this.renderMoreOptions(form, t);
    this.renderOptionalFields(form, t);

    const footerContainer = this.contentEl.createDiv({
      cls: "ntfy-sync-composer-footer-container",
    });
    this.validationEl = footerContainer.createDiv({ cls: "ntfy-sync-composer-validation" });
    this.validationEl.dataset.testid = "ntfy-composer-validation";
    this.validationEl.setAttr("role", "alert");
    this.statusEl = footerContainer.createDiv({ cls: "ntfy-sync-composer-status" });
    this.statusEl.dataset.testid = "ntfy-composer-status";
    this.statusEl.setAttrs({ role: "status", "aria-live": "polite" });

    const footer = new Setting(footerContainer).setClass("ntfy-sync-composer-footer");
    footer.addButton((button) => {
      button.buttonEl.dataset.testid = "ntfy-composer-clear";
      button.setButtonText(t("composer.clear")).onClick(() => this.clearDraft());
    });
    footer.addButton((button) => {
      this.submitButton = button.buttonEl;
      button.buttonEl.dataset.testid = "ntfy-composer-submit";
      button
        .setButtonText(t("composer.publish"))
        .setCta()
        .onClick(() => void this.publish());
    });
  }

  private configureConnectionSearch(search: SearchComponent, placeholder: string): void {
    search.inputEl.dataset.testid = "ntfy-composer-connection";
    search.clearButtonEl.dataset.testid = "ntfy-composer-connection-clear";
    search
      .setPlaceholder(placeholder)
      .setValue(this.draft.baseUrl)
      .onChange((value) => {
        this.draft.baseUrl = value.trim();
        this.clearFeedback();
      });
    const container = search.inputEl.closest<HTMLElement>(".search-input-container");
    container?.addClass("ntfy-sync-composer-search");
    this.connectionSuggester = new ComposerConnectionSuggest(
      this.app,
      search.inputEl,
      () => this.plugin.settings.connections,
    );
    this.bindSearchSuggestions(search);
  }

  private installFooterInsetTracking(): void {
    this.footerInsetCleanup?.();
    const ownerDocument = this.contentEl.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return;
    let updateTimer: number | undefined;
    let settleTimer: number | undefined;
    let observedStatusBar: HTMLElement | undefined;
    const resizeObserver = new ownerWindow.ResizeObserver(() => queueUpdate());
    const update = (): void => {
      if (!this.contentEl.isConnected) return;
      const statusBar = ownerDocument.querySelector<HTMLElement>(".status-bar") ?? undefined;
      if (statusBar !== observedStatusBar) {
        if (observedStatusBar) resizeObserver.unobserve(observedStatusBar);
        if (statusBar) resizeObserver.observe(statusBar);
        observedStatusBar = statusBar;
      }
      const rootRect = this.contentEl.getBoundingClientRect();
      const statusRect = statusBar?.getBoundingClientRect();
      const statusStyle = statusBar ? ownerWindow.getComputedStyle(statusBar) : undefined;
      const intersectsHorizontally = Boolean(
        statusRect && statusRect.left < rootRect.right && statusRect.right > rootRect.left,
      );
      const statusVisible = Boolean(
        statusRect &&
          statusRect.height > 0 &&
          statusStyle?.display !== "none" &&
          statusStyle?.visibility !== "hidden",
      );
      const inset =
        statusVisible && intersectsHorizontally && statusRect && rootRect.bottom > statusRect.top
          ? Math.ceil(Math.min(rootRect.height, rootRect.bottom - statusRect.top))
          : 0;
      this.contentEl.setCssProps({ "--ntfy-composer-status-bar-inset": `${inset}px` });
    };
    const queueUpdate = (): void => {
      if (updateTimer !== undefined) ownerWindow.clearTimeout(updateTimer);
      if (settleTimer !== undefined) ownerWindow.clearTimeout(settleTimer);
      updateTimer = ownerWindow.setTimeout(() => {
        updateTimer = undefined;
        update();
      }, 0);
      settleTimer = ownerWindow.setTimeout(() => {
        settleTimer = undefined;
        update();
      }, 250);
    };
    resizeObserver.observe(this.contentEl);
    const bodyObserver = new ownerWindow.MutationObserver(queueUpdate);
    bodyObserver.observe(ownerDocument.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const themeObserver = new ownerWindow.MutationObserver(queueUpdate);
    themeObserver.observe(ownerDocument.head, {
      attributes: true,
      attributeFilter: ["href"],
      childList: true,
      subtree: true,
    });
    ownerDocument.addEventListener("load", queueUpdate, true);
    ownerWindow.addEventListener("resize", queueUpdate);
    update();
    queueUpdate();
    this.footerInsetCleanup = () => {
      if (updateTimer !== undefined) ownerWindow.clearTimeout(updateTimer);
      if (settleTimer !== undefined) ownerWindow.clearTimeout(settleTimer);
      resizeObserver.disconnect();
      bodyObserver.disconnect();
      themeObserver.disconnect();
      ownerDocument.removeEventListener("load", queueUpdate, true);
      ownerWindow.removeEventListener("resize", queueUpdate);
      this.contentEl.setCssProps({ "--ntfy-composer-status-bar-inset": "" });
    };
  }

  private configureTopicSearch(search: SearchComponent, placeholder: string): void {
    search.inputEl.dataset.testid = "ntfy-composer-topic";
    search.clearButtonEl.dataset.testid = "ntfy-composer-topic-clear";
    search
      .setPlaceholder(placeholder)
      .setValue(this.draft.topic)
      .onChange((value) => {
        this.draft.topic = value.trim();
        this.clearFeedback();
      });
    const container = search.inputEl.closest<HTMLElement>(".search-input-container");
    container?.addClass("ntfy-sync-composer-search");
    this.topicSuggester = new ComposerTopicSuggest(this.app, search.inputEl, () =>
      uniqueTopics(
        this.selectedConnection()?.topics ?? allConfiguredTopics(this.plugin.settings.connections),
      ),
    );
    this.bindSearchSuggestions(search);
  }

  private selectedConnection(): ConnectionConfigV1 | undefined {
    const selected = connectionOrigin(this.draft.baseUrl);
    return this.plugin.settings.connections.find(
      (connection) => connectionOrigin(connection.baseUrl) === selected,
    );
  }

  private renderOptionalFields(form: HTMLElement, t: I18n["t"]): void {
    if (this.optionalFields.has("priority") || this.draft.priority !== undefined) {
      new Setting(form)
        .setName(t("composer.priority"))
        .setClass("ntfy-sync-composer-compact-inline")
        .setClass("ntfy-sync-composer-inline")
        .addDropdown((dropdown) => {
          dropdown.selectEl.dataset.testid = "ntfy-composer-priority";
          dropdown
            .addOptions({
              "1": t("publishTest.priorityMin"),
              "2": t("publishTest.priorityLow"),
              "3": t("publishTest.priorityDefault"),
              "4": t("publishTest.priorityHigh"),
              "5": t("publishTest.priorityMax"),
            })
            .setValue(String(this.draft.priority ?? 3))
            .onChange((value) => {
              this.draft.priority = Number(value) as 1 | 2 | 3 | 4 | 5;
              this.clearFeedback();
            });
        });
    }
    if (this.optionalFields.has("clickUrl") || this.draft.clickUrl) {
      this.renderOptionalTextSetting(form, {
        name: t("composer.clickUrl"),
        placeholder: t("composer.clickUrlPlaceholder"),
        testId: "ntfy-composer-click-url",
        value: this.draft.clickUrl,
        onChange: (value) => (this.draft.clickUrl = value),
      });
    }
    if (this.optionalFields.has("email") || this.draft.email) {
      this.renderOptionalTextSetting(form, {
        name: t("composer.email"),
        placeholder: t("composer.emailPlaceholder"),
        testId: "ntfy-composer-email",
        value: this.draft.email,
        type: "email",
        onChange: (value) => (this.draft.email = value),
      });
    }
    if (this.optionalFields.has("attachmentUrl") || this.draft.attachmentUrl) {
      this.renderOptionalTextSetting(form, {
        name: t("composer.attachmentUrl"),
        placeholder: t("composer.attachmentUrlPlaceholder"),
        testId: "ntfy-composer-attachment-url",
        value: this.draft.attachmentUrl,
        onChange: (value) => {
          this.draft.attachmentUrl = value;
          if (value) this.draft.attachmentPath = "";
        },
      });
      this.renderOptionalTextSetting(form, {
        name: t("composer.filename"),
        placeholder: t("composer.filenamePlaceholder"),
        testId: "ntfy-composer-filename",
        value: this.draft.filename,
        onChange: (value) => (this.draft.filename = value),
      });
    }
    if (this.optionalFields.has("delay") || this.draft.delay) {
      this.renderOptionalTextSetting(form, {
        name: t("composer.delay"),
        placeholder: t("composer.delayPlaceholder"),
        testId: "ntfy-composer-delay",
        value: this.draft.delay,
        onChange: (value) => (this.draft.delay = value),
      });
    }
  }

  private renderOptionalTextSetting(
    form: HTMLElement,
    options: {
      name: string;
      placeholder: string;
      testId: string;
      value: string;
      type?: "email" | "url";
      onChange: (value: string) => void;
    },
  ): void {
    new Setting(form)
      .setName(options.name)
      .setClass("ntfy-sync-composer-compact-inline")
      .setClass("ntfy-sync-composer-inline")
      .addText((text) => {
        text.inputEl.dataset.testid = options.testId;
        if (options.type) text.inputEl.type = options.type;
        text
          .setPlaceholder(options.placeholder)
          .setValue(options.value)
          .onChange((value) => {
            options.onChange(value.trim());
            this.clearFeedback();
          });
      });
  }

  private renderMoreOptions(form: HTMLElement, t: I18n["t"]): void {
    const options = [
      ["priority", t("composer.priority")],
      ["clickUrl", t("composer.addClickUrl")],
      ["email", t("composer.addEmail")],
      ["attachmentUrl", t("composer.addAttachmentUrl")],
      ["delay", t("composer.addDelay")],
    ] as const;
    const setting = new Setting(form)
      .setName(t("composer.moreOptions"))
      .setClass("ntfy-sync-composer-compact-inline")
      .setClass("ntfy-sync-composer-inline")
      .setClass("ntfy-sync-composer-more-options");
    const details = setting.controlEl.createEl("details", {
      cls: "ntfy-sync-composer-multi-select",
    });
    details.dataset.testid = "ntfy-composer-more-options";
    const ownerDocument = this.contentEl.ownerDocument;
    const summary = details.createEl("summary", {
      text: this.moreOptionsSummary(t),
    });
    summary.dataset.testid = "ntfy-composer-more-options-summary";
    const list = ownerDocument.body.createDiv({ cls: "ntfy-sync-composer-multi-select-list" });
    list.setAttr("popover", "manual");
    this.moreOptionsPortalCleanup = () => list.remove();
    const closeOnOutsidePointer = (event: Event): void => {
      const target = event.target as Node | null;
      if (details.open && target && !details.contains(target) && !list.contains(target)) {
        details.open = false;
      }
    };
    ownerDocument.addEventListener("pointerdown", closeOnOutsidePointer, true);
    this.outsideClickCleanup = () =>
      ownerDocument.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    const positionList = (): void => {
      if (!details.open) return;
      const rect = summary.getBoundingClientRect();
      const view = ownerDocument.defaultView;
      if (!view) return;
      list.setCssProps({
        "--ntfy-multi-select-left": `${Math.round(rect.left)}px`,
        "--ntfy-multi-select-top": `${Math.round(rect.bottom + 4)}px`,
        "--ntfy-multi-select-width": `${Math.round(rect.width)}px`,
        "--ntfy-multi-select-max-height": `${Math.max(120, Math.min(224, Math.round(view.innerHeight - rect.bottom - 12)))}px`,
      });
    };
    details.addEventListener("toggle", () => {
      if (!details.isConnected || !list.isConnected) return;
      if (details.open) {
        positionList();
        if (!list.matches(":popover-open")) list.showPopover();
      } else if (list.matches(":popover-open")) {
        list.hidePopover();
      }
    });
    for (const [field, label] of options) {
      const option = list.createEl("label", { cls: "ntfy-sync-composer-multi-select-option" });
      const checkbox = option.createEl("input", { type: "checkbox" });
      checkbox.value = field;
      checkbox.dataset.testid = `ntfy-composer-option-${field.replace(/[A-Z]/gu, (letter) => `-${letter.toLocaleLowerCase()}`)}`;
      checkbox.checked = this.optionalFields.has(field);
      option.createSpan({ text: label });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.optionalFields.add(field);
          if (field === "priority" && this.draft.priority === undefined) this.draft.priority = 3;
        } else {
          this.optionalFields.delete(field);
          this.clearOptionalField(field);
        }
        const scrollTop = form.scrollTop;
        this.render();
        const nextForm = this.contentEl.querySelector<HTMLElement>(".ntfy-sync-composer-form");
        if (nextForm) nextForm.scrollTop = scrollTop;
        const nextDetails = this.contentEl.querySelector<HTMLDetailsElement>(
          '[data-testid="ntfy-composer-more-options"]',
        );
        if (nextDetails) nextDetails.open = true;
      });
    }
  }

  private moreOptionsSummary(t: I18n["t"]): string {
    const count = this.optionalFields.size;
    return count === 0 ? t("composer.selectOption") : t("composer.selectedOptions", { count });
  }

  private clearOptionalField(field: OptionalComposerField): void {
    if (field === "priority") this.draft.priority = undefined;
    if (field === "clickUrl") this.draft.clickUrl = "";
    if (field === "email") this.draft.email = "";
    if (field === "delay") this.draft.delay = "";
    if (field === "attachmentUrl") {
      this.draft.attachmentUrl = "";
      this.draft.filename = "";
    }
  }

  private configureFileSearch(search: SearchComponent, placeholder: string): void {
    search.inputEl.dataset.testid = "ntfy-composer-file";
    search.clearButtonEl.dataset.testid = "ntfy-composer-file-clear";
    search
      .setPlaceholder(placeholder)
      .setValue(this.draft.attachmentPath)
      .onChange((value) => {
        this.draft.attachmentPath = value.trim();
        if (this.draft.attachmentPath) {
          this.draft.attachmentUrl = "";
          this.draft.filename = "";
        }
        this.clearFeedback();
      });
    const container = search.inputEl.closest<HTMLElement>(".search-input-container");
    container?.addClass("ntfy-sync-composer-search");
    this.fileSuggester = new ComposerFileSuggest(this.app, search.inputEl, () =>
      this.app.vault.getFiles(),
    );
    this.bindSearchSuggestions(search);
  }

  private bindSearchSuggestions(search: SearchComponent): void {
    const requestSuggestions = (): void => {
      search.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    };
    search.inputEl.addEventListener("focus", requestSuggestions);
    search.inputEl.addEventListener("click", requestSuggestions);
    search.clearButtonEl.addEventListener("click", () => {
      queueMicrotask(() => {
        search.inputEl.focus();
        requestSuggestions();
      });
    });
  }

  private async publish(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    this.publishController = new AbortController();
    this.submitButton?.setAttr("disabled", "true");
    this.submitButton?.setText(this.plugin.i18n.t("composer.publishing"));
    this.clearFeedback();
    try {
      const attachment = await this.readAttachment();
      await publishConfiguredMessage(
        this.plugin.settings,
        {
          baseUrl: this.draft.baseUrl,
          topic: this.draft.topic,
          title: this.draft.title,
          message: this.draft.message,
          priority: this.draft.priority,
          tags: parseTags(this.draft.tagsText),
          clickUrl: this.draft.clickUrl,
          email: this.draft.email,
          delay: this.draft.delay,
          markdown: this.draft.markdown,
          attachmentUrl: this.draft.attachmentUrl,
          filename: this.draft.filename,
          attachment,
        },
        {},
        this.publishController.signal,
      );
      const message = this.plugin.i18n.t("composer.published");
      this.statusEl?.setText(message);
      new Notice(message);
    } catch (error) {
      this.showError(error);
    } finally {
      this.publishing = false;
      this.publishController = undefined;
      this.submitButton?.removeAttribute("disabled");
      this.submitButton?.setText(this.plugin.i18n.t("composer.publish"));
    }
  }

  private async readAttachment(): Promise<{ name: string; data: ArrayBuffer } | undefined> {
    if (!this.draft.attachmentPath) return undefined;
    const file = this.app.vault.getAbstractFileByPath(this.draft.attachmentPath);
    if (!(file instanceof TFile)) throw new TestPublishValidationError("FILE_INVALID");
    if (file.stat.size > this.plugin.settings.processing.maxAttachmentBytes) {
      throw new TestPublishValidationError("FILE_TOO_LARGE");
    }
    return { name: file.name, data: await this.app.vault.readBinary(file) };
  }

  private showError(error: unknown): void {
    if (error instanceof TestPublishValidationError) {
      if (error.code === "CONFIG_INVALID" && error.issue) {
        this.validationEl?.setText(
          `${error.issue.path}: ${localizeValidationIssue(this.plugin.i18n, error.issue)}`,
        );
        return;
      }
      const keys: Partial<Record<TestPublishValidationError["code"], TranslationKey>> = {
        CONNECTION_MISSING: "composer.noConnection",
        CONNECTION_INVALID: "composer.connectionInvalid",
        TOPIC_INVALID: "composer.topicInvalid",
        PRIORITY_INVALID: "publishTest.priorityInvalid",
        TITLE_TOO_LARGE: "composer.titleTooLarge",
        TAGS_INVALID: "composer.tagsInvalid",
        CLICK_URL_INVALID: "composer.clickUrlInvalid",
        EMAIL_INVALID: "composer.emailInvalid",
        DELAY_INVALID: "composer.delayInvalid",
        ATTACHMENT_URL_INVALID: "composer.attachmentUrlInvalid",
        ATTACHMENT_CONFLICT: "composer.attachmentConflict",
        FILENAME_INVALID: "composer.filenameInvalid",
        MESSAGE_REQUIRED: "publishTest.messageRequired",
        MESSAGE_TOO_LARGE: "publishTest.messageTooLarge",
        FILE_INVALID: "composer.fileInvalid",
        FILE_TOO_LARGE: "publishTest.fileTooLarge",
      };
      const key = keys[error.code];
      if (key) this.validationEl?.setText(this.plugin.i18n.t(key));
      return;
    }
    this.validationEl?.setText(
      this.plugin.i18n.t("composer.failed", { code: safeErrorCode(error) }),
    );
  }

  private clearFeedback(): void {
    this.validationEl?.empty();
    this.statusEl?.empty();
  }

  private closeSuggesters(): void {
    this.connectionSuggester?.close();
    this.connectionSuggester = undefined;
    this.topicSuggester?.close();
    this.topicSuggester = undefined;
    this.fileSuggester?.close();
    this.fileSuggester = undefined;
  }
}

function connectionOrigin(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname.replace(/\/+$/u, "") === "/" ? "" : url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return rawUrl.trim();
  }
}

function uniqueTopics(topics: string[]): string[] {
  return [...new Set(topics)].sort((left, right) => left.localeCompare(right));
}

function allConfiguredTopics(connections: ConnectionConfigV1[]): string[] {
  return uniqueTopics(connections.flatMap((connection) => connection.topics));
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "UNKNOWN";
  const code = String(error.code);
  return /^[A-Z0-9_]{1,40}$/u.test(code) ? code : "UNKNOWN";
}
