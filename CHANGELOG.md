# Changelog

All notable changes to this project are documented in this file.

## Unreleased

## 0.1.6

- Moved detailed rule fields, operators, path constraints, and template variables from the bilingual README files into dedicated bilingual configuration references, keeping the project landing pages concise.
- Added a right-sidebar ntfy message composer, ribbon entry, and Obsidian commands for custom messages, editor selections, current-note links, and active Vault files, with editable connection/topic suggestions, title, Markdown, tags, a checkbox multi-select for optional priority/Click URL/email/delay/remote attachments, bilingual UI, and shared publish transport.
- Fixed the Send selection command so the real command palette preserves Markdown editor or reading-view selections, named the ribbon entry explicitly as the Ntfy message composer, and anchored the More options popover to its trigger instead of the window edge.
- Kept Clear and Publish above floating status bars across Default, Border, Minimal, and Things themes, including background-window and asynchronous theme-load updates.
- Tightened the composer content inset, replaced the large heading and redundant description with an ordinary `Publish Ntfy notification` title beside Settings, and matched More options typography to native selects.
- Made Clear preserve destination, format, selected optional fields, priority, and user-resized Message geometry while clearing payload values; shortened publish success feedback to `Message published` / `消息已发布`.
- Matched validation and publish-success feedback to Obsidian's smaller UI typography, and added reviewed 1440×900 bilingual README screenshots with the title tab, ribbon, sidebar composer, and status bar visible.
- Matched the MQTT Sync settings hierarchy with independent transparent title, primary-connection, and message-rules headings; moved Apply into the primary heading and removed the bottom Apply row.
- Removed inline spacing from the message distribution rule list so cards fill the same outer width as the rules heading.
- Added a Publish test dialog beside Apply for configured-topic text/link publishing, priority 1–5, and optional Vault text, Markdown, or common-image uploads.
- Added cancellable single-request finite publishing that blocks redirects and avoids duplicate notifications when a response fails after sending, plus automated plain-message, binary-upload, validation, UI-layout, and real-loop acceptance coverage.
- Limited reading-view selection retention to a short-lived, file-scoped memory cache that clears when the active leaf or file changes.
- Added bilingual status-indicator reference diagrams with the current tooltip, status bar, and all eight icon states.

## 0.1.5

- Reworked the English and Simplified Chinese README content for a clearer overview, configuration guide, acceptance matrix, security limits, and project provenance.
- Updated the bilingual six-stage message-to-knowledge workflow diagrams, including attached parallel flow arrows and synchronized layout and labels.
- Replaced embedded double-extension workflow images with standard single-extension PNG assets exported with consistent padding.

## 0.1.4

- Corrected the declarative rule-list width on Obsidian 1.13.4 and removed the redundant priority-arrow hint.

## 0.1.3

- Added searchable declarative setting definitions for Obsidian 1.13 and later while retaining the imperative settings fallback for the declared minimum version, Obsidian 1.12.7.
- Kept dynamic authentication, result publishing, rule cards, localization, validation, and reconnect side effects consistent across both settings implementations.
- Updated the Obsidian API development dependency to 1.13.1 and added unit coverage for dynamic search metadata and secret exclusion.

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
