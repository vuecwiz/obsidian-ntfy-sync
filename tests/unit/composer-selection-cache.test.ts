import {
  COMPOSER_SELECTION_CACHE_TTL_MS,
  ComposerSelectionCache,
} from "../../src/ui/composer-selection-cache";

describe("ComposerSelectionCache", () => {
  it("retains a reading-view selection briefly for the same file", () => {
    const cache = new ComposerSelectionCache();
    cache.remember("Notes/one.md", "selected text", 1_000);

    expect(cache.recall("Notes/one.md", 1_000 + COMPOSER_SELECTION_CACHE_TTL_MS - 1)).toBe(
      "selected text",
    );
  });

  it("expires a cached selection after the short retention window", () => {
    const cache = new ComposerSelectionCache();
    cache.remember("Notes/one.md", "stale text", 1_000);

    expect(cache.recall("Notes/one.md", 1_000 + COMPOSER_SELECTION_CACHE_TTL_MS)).toBe("");
  });

  it("discards the old selection when another file requests it", () => {
    const cache = new ComposerSelectionCache();
    cache.remember("Notes/one.md", "stale text", 1_000);

    expect(cache.recall("Notes/two.md", 1_001)).toBe("");
    expect(cache.recall("Notes/one.md", 1_002)).toBe("");
  });

  it("can be cleared when the active leaf or file changes", () => {
    const cache = new ComposerSelectionCache();
    cache.remember("Notes/one.md", "stale text", 1_000);

    cache.clear();

    expect(cache.recall("Notes/one.md", 1_001)).toBe("");
  });
});
