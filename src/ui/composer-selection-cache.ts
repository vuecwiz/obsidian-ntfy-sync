export const COMPOSER_SELECTION_CACHE_TTL_MS = 5_000;

interface ComposerSelectionCacheEntry {
  filePath: string;
  text: string;
  expiresAt: number;
}

export class ComposerSelectionCache {
  private entry?: ComposerSelectionCacheEntry;

  remember(filePath: string, text: string, now = Date.now()): void {
    this.entry = { filePath, text, expiresAt: now + COMPOSER_SELECTION_CACHE_TTL_MS };
  }

  recall(filePath: string, now = Date.now()): string {
    const entry = this.entry;
    if (!entry || entry.filePath !== filePath || now >= entry.expiresAt) {
      this.clear();
      return "";
    }
    return entry.text;
  }

  clear(): void {
    this.entry = undefined;
  }
}
