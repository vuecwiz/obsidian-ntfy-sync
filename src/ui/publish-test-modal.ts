import {
  AbstractInputSuggest,
  Modal,
  Notice,
  Setting,
  type App,
  type SearchComponent,
  TFile,
} from "obsidian";
import type NtfySyncPlugin from "../main";
import { publishConfiguredTestMessage, TestPublishValidationError } from "../app/test-publisher";
import { localizeValidationIssue, type I18n } from "../i18n";

class ConfiguredTopicSuggest extends AbstractInputSuggest<string> {
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
    el.dataset.testid = "ntfy-publish-test-topic-suggestion";
    el.setText(topic);
  }

  override selectSuggestion(topic: string): void {
    this.inputEl.value = topic;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}

const SUPPORTED_FILE_EXTENSIONS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
]);

class PublishFileSuggest extends AbstractInputSuggest<TFile> {
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
      .filter(
        (file) =>
          SUPPORTED_FILE_EXTENSIONS.has(file.extension.toLocaleLowerCase()) &&
          file.path.toLocaleLowerCase().includes(normalized),
      )
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, this.limit);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.dataset.testid = "ntfy-publish-test-file-suggestion";
    el.setText(file.path);
  }

  override selectSuggestion(file: TFile): void {
    this.inputEl.value = file.path;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}

export class PublishTestMessageModal extends Modal {
  private topic: string;
  private message = "";
  private priority: 1 | 2 | 3 | 4 | 5 = 3;
  private attachmentPath = "";
  private validationEl?: HTMLElement;
  private topicSuggester?: ConfiguredTopicSuggest;
  private fileSuggester?: PublishFileSuggest;
  private publishing = false;

  constructor(
    app: App,
    private readonly plugin: NtfySyncPlugin,
  ) {
    super(app);
    this.topic = plugin.settings.connections[0]?.topics[0] ?? "";
  }

  override onOpen(): void {
    this.modalEl.addClass("ntfy-sync-test-publish-modal");
    this.modalEl.dataset.testid = "ntfy-publish-test-modal";
    this.render();
  }

  override onClose(): void {
    this.topicSuggester?.close();
    this.topicSuggester = undefined;
    this.fileSuggester?.close();
    this.fileSuggester = undefined;
    this.contentEl.empty();
  }

  private render(): void {
    const i18n = this.plugin.i18n;
    const t: I18n["t"] = (key, variables) => i18n.t(key, variables);
    const topics = this.plugin.settings.connections[0]?.topics ?? [];
    this.contentEl.empty();
    this.modalEl.dataset.locale = i18n.locale;
    this.titleEl.setText(t("publishTest.title"));

    new Setting(this.contentEl).setName(t("publishTest.topic")).addSearch((search) => {
      this.configureTopicSearch(search, topics, t("publishTest.topicPlaceholder"));
    });

    new Setting(this.contentEl).setName(t("publishTest.priority")).addDropdown((dropdown) => {
      dropdown.selectEl.dataset.testid = "ntfy-publish-test-priority";
      dropdown
        .addOptions({
          "1": t("publishTest.priorityMin"),
          "2": t("publishTest.priorityLow"),
          "3": t("publishTest.priorityDefault"),
          "4": t("publishTest.priorityHigh"),
          "5": t("publishTest.priorityMax"),
        })
        .setValue(String(this.priority))
        .onChange((value) => {
          this.priority = Number(value) as 1 | 2 | 3 | 4 | 5;
          this.validationEl?.empty();
        });
    });

    new Setting(this.contentEl).setName(t("publishTest.file")).addSearch((search) => {
      this.configureFileSearch(search, t("publishTest.filePlaceholder"));
    });

    new Setting(this.contentEl)
      .setName(t("publishTest.message"))
      .setClass("ntfy-sync-test-publish-message")
      .addTextArea((textarea) => {
        textarea.inputEl.dataset.testid = "ntfy-publish-test-message";
        textarea
          .setPlaceholder(t("publishTest.messagePlaceholder"))
          .setValue(this.message)
          .onChange((value) => {
            this.message = value;
            this.validationEl?.empty();
          });
      });

    this.validationEl = this.contentEl.createDiv({ cls: "ntfy-sync-test-publish-validation" });
    this.validationEl.dataset.testid = "ntfy-publish-test-validation";
    this.validationEl.setAttr("role", "alert");

    const footer = new Setting(this.contentEl).setClass("ntfy-sync-test-publish-footer");
    footer.addButton((button) => {
      button.buttonEl.dataset.testid = "ntfy-publish-test-submit";
      button
        .setButtonText(t("publishTest.publish"))
        .setCta()
        .onClick(async () => {
          if (this.publishing) return;
          this.publishing = true;
          button.setDisabled(true).setButtonText(t("publishTest.publishing"));
          try {
            const attachment = await this.readAttachment();
            await publishConfiguredTestMessage(this.plugin.settings, {
              topic: this.topic,
              message: this.message,
              priority: this.priority,
              attachment,
            });
            new Notice(t("notice.testPublished"));
            this.close();
          } catch (error) {
            this.showError(error);
            button.setDisabled(false).setButtonText(t("publishTest.publish"));
          } finally {
            this.publishing = false;
          }
        });
    });
    footer.addButton((button) => {
      button.buttonEl.dataset.testid = "ntfy-publish-test-cancel";
      button.setButtonText(t("publishTest.cancel")).onClick(() => this.close());
    });
  }

  private configureFileSearch(search: SearchComponent, placeholder: string): void {
    search.inputEl.dataset.testid = "ntfy-publish-test-file";
    search.clearButtonEl.dataset.testid = "ntfy-publish-test-file-clear";
    const container = search.inputEl.closest<HTMLElement>(".search-input-container");
    if (container) {
      container.addClass("ntfy-sync-test-publish-file-search");
      container.dataset.testid = "ntfy-publish-test-file-search";
    }
    search
      .setPlaceholder(placeholder)
      .setValue(this.attachmentPath)
      .onChange((value) => {
        this.attachmentPath = value.trim();
        this.validationEl?.empty();
      });
    this.fileSuggester = new PublishFileSuggest(this.app, search.inputEl, () =>
      this.app.vault.getFiles(),
    );
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

  private async readAttachment(): Promise<{ name: string; data: ArrayBuffer } | undefined> {
    if (!this.attachmentPath) return undefined;
    const file = this.app.vault.getAbstractFileByPath(this.attachmentPath);
    if (!(file instanceof TFile) || !SUPPORTED_FILE_EXTENSIONS.has(file.extension.toLowerCase())) {
      throw new TestPublishValidationError("FILE_INVALID");
    }
    if (file.stat.size > this.plugin.settings.processing.maxAttachmentBytes) {
      throw new TestPublishValidationError("FILE_TOO_LARGE");
    }
    return { name: file.name, data: await this.app.vault.readBinary(file) };
  }

  private configureTopicSearch(
    search: SearchComponent,
    topics: string[],
    placeholder: string,
  ): void {
    search.inputEl.dataset.testid = "ntfy-publish-test-topic";
    search.clearButtonEl.dataset.testid = "ntfy-publish-test-topic-clear";
    const container = search.inputEl.closest<HTMLElement>(".search-input-container");
    if (container) {
      container.addClass("ntfy-sync-test-publish-topic-search");
      container.dataset.testid = "ntfy-publish-test-topic-search";
    }
    search
      .setPlaceholder(placeholder)
      .setValue(this.topic)
      .onChange((value) => {
        this.topic = value.trim();
        this.validationEl?.empty();
      });
    this.topicSuggester = new ConfiguredTopicSuggest(this.app, search.inputEl, () => topics);
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

  private showError(error: unknown): void {
    if (error instanceof TestPublishValidationError) {
      if (error.code === "CONFIG_INVALID" && error.issue) {
        this.validationEl?.setText(
          `${error.issue.path}: ${localizeValidationIssue(this.plugin.i18n, error.issue)}`,
        );
        return;
      }
      const keys = {
        CONNECTION_MISSING: "publishTest.topicInvalid",
        TOPIC_INVALID: "publishTest.topicInvalid",
        PRIORITY_INVALID: "publishTest.priorityInvalid",
        MESSAGE_REQUIRED: "publishTest.messageRequired",
        MESSAGE_TOO_LARGE: "publishTest.messageTooLarge",
        FILE_INVALID: "publishTest.fileInvalid",
        FILE_TOO_LARGE: "publishTest.fileTooLarge",
      } as const;
      const key =
        error.code !== "CONFIG_INVALID" && error.code in keys
          ? keys[error.code as keyof typeof keys]
          : undefined;
      if (!key) return;
      this.validationEl?.setText(this.plugin.i18n.t(key));
      return;
    }
    const code = safeErrorCode(error);
    this.validationEl?.setText(this.plugin.i18n.t("publishTest.failed", { code }));
  }
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "UNKNOWN";
  const code = String(error.code);
  return /^[A-Z0-9_]{1,40}$/u.test(code) ? code : "UNKNOWN";
}
