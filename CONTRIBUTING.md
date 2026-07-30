# Contributing

Thanks for helping improve Ntfy Sync. Bug reports, focused feature proposals, documentation fixes, and tested pull requests are welcome.

## Before opening an issue

Search existing issues first. For a bug, include the plugin and Obsidian versions, operating system, ntfy server version or hosted service, transport mode, expected behavior, and sanitized reproduction steps. Never post credentials, topic names, message bodies, private Vault paths, attachment URLs, or raw `data.json` and state files. Report security issues through the private process in [SECURITY.md](SECURITY.md).

## Development

Use Node.js 22 or newer and install exactly from the lockfile:

```sh
npm ci
npm run verify
```

Keep protocol DTOs under `src/transport/ntfy`, preserve the durable accept-before-process boundary, and add deterministic tests for behavior changes. Public-network and GUI tests must remain outside the default unit suite.

## Obsidian and ntfy acceptance

Set `OBSIDIAN_NTFY_TEST_VAULT` to a disposable Vault whose directory name contains `test`. The install helper rejects other targets. Use dedicated non-production ntfy topics and inject secrets only through environment variables or another ignored local mechanism.

```sh
npm run build
npm run install:test-vault
npm run test:ui
npm run test:acceptance
```

Acceptance artifacts are written below `.artifacts/` and may contain sensitive local context. Do not commit them. A screenshot alone is not persistence evidence; UI changes should also verify saved state, reopen or reload behavior, and new plugin-attributable errors.

## Pull requests

Keep changes focused, update English and Simplified Chinese user documentation together when behavior changes, and describe the tests actually run. Before submitting, run `npm run verify`, inspect the diff for secrets and private paths, and confirm that disabling the plugin stops streams and timers without removing existing Vault content.

By contributing, you agree that your contribution is licensed under `AGPL-3.0-only`.

## Maintainer release process

Update `package.json`, `manifest.json`, and `versions.json` to the same release version, then run `npm run verify` and `npm run package:release -- --tag VERSION`. Inspect the ZIP and checksum under `.artifacts/release/`. Push the reviewed commit before pushing an exact `VERSION` tag such as `0.2.0`; tags prefixed with `v` are intentionally rejected. GitHub Actions reruns the quality gate and publishes the generated ZIP, checksum, `main.js`, `manifest.json`, and `styles.css` as release assets.
