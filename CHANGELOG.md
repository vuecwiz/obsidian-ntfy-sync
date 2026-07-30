# Changelog

All notable changes to this project are documented in this file.

## 0.1.2

- Replaced direct Node.js filesystem state access with Obsidian's Vault adapter while preserving the existing state paths, checksums, backups, corruption isolation, and interrupted-replacement recovery.
- Documented that rule path suggestions enumerate Vault paths without reading file contents.
- Replaced CSS `column-gap` with supported grid `gap` declarations and removed `!important` from reduced-motion overrides.
- Added fault injection for an interrupted adapter state replacement.
- Made both UI runners enable the plugin when necessary and restore its original enabled state during cleanup.

## 0.1.1

- Updated the manifest description to meet the Community Plugins policy.
- Replaced manual settings headings, inline style assignments, native DOM creation, unsafe Vault file casts, unbound translation methods, and non-window timers with Obsidian-compatible APIs.
- Switched finite ntfy poll and publish requests to `requestUrl`; retained streaming fetch only where buffered requests cannot support NDJSON streams, aborts, bounded attachment reads, or controlled redirects.
- Made transport failures proper `Error` instances and kept their retry, status, and `Retry-After` metadata.
- Made release ZIP bytes reproducible across host time zones and added a cross-time-zone packaging check.
- Preserved the imperative settings UI for compatibility with the declared minimum Obsidian version, 1.12.7.

## 0.1.0

- Changed the pre-directory plugin ID to the policy-compliant `ntfy-sync` before submission to the Obsidian Community directory.
- Added deterministic release ZIP packaging with version, file-allowlist, and SHA-256 validation.
- Added tag-triggered GitHub Releases and manually triggered Actions artifacts containing the installable plugin files.
- Added a desktop Obsidian plugin with durable ntfy stream/poll ingestion, overlap replay, bounded deduplication, and reconnect fallback.
- Added deterministic first-match routing, structured rule editing, templates, safe Vault-relative paths, idempotent markers, and serialized writes.
- Added guarded same-origin attachment downloads, an optional result outbox, redacted diagnostics, and recovery from checksummed state backups.
- Added English and Simplified Chinese settings, status icons and details, accessible controls, and sanitized configuration screenshots.
- Added unit, contract, integration, coverage, secret-scan, reproducible-build, isolated Obsidian, and ntfy acceptance tooling.
