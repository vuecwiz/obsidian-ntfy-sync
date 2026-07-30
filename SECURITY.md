# Security policy

## Reporting a vulnerability

Please do not disclose vulnerabilities in a public issue. Use GitHub's **Security → Report a vulnerability** flow so the report and follow-up remain private. Include the affected version, impact, reproduction steps, and a minimal sanitized proof of concept. Do not include real credentials, topic names, message bodies, attachment URLs, proxy values, or Vault extracts.

There is currently no guaranteed response-time SLA. A report is considered resolved only after a fix or documented mitigation is available and the reporter has had a reasonable opportunity to verify it.

## Security boundary

Authentication secrets are stored in Obsidian plugin `data.json` and are protected only by local filesystem and Vault permissions. Vault synchronization software may copy those secrets to other devices. Diagnostic exports redact credentials, bodies, topic values, URL queries, and absolute paths; generated test artifacts are ignored and checked by `npm run test:secrets`.

Durable runtime state is read and written through Obsidian's Vault adapter under the plugin directory. Runtime code does not import Node.js `fs` or construct an absolute filesystem path. The rule editor calls Vault file-list APIs only when it needs note or attachment path suggestions; it uses the returned paths for matching and display and does not read file contents as part of suggestion generation.

Input and result credentials are separate. Use authorization headers, distinct non-guessable topics, and least-privilege ACLs. Never place authentication values in URLs. The loopback HTTP option exists only for isolated testing; other servers require HTTPS.

External attachment URLs are link-only. Automatic download is limited to the configured ntfy origin, uses manual redirects, blocks cross-origin redirects, never forwards credentials across origins, enforces declared and actual byte limits, stages output, and verifies a SHA-256 receipt. Only HTTP(S) link targets are accepted, and Markdown metacharacters are escaped.

## Deployment checklist

- Confirm input and result topics are distinct, random, and covered by minimal ACLs.
- Confirm ntfy cache persistence and duration exceed the required offline window.
- Run `npm ci`, `npm run verify`, and `npm audit --audit-level=high` from the committed lockfile.
- Run `npm run test:acceptance` against an explicitly selected isolated test Vault and inspect the machine report.
- Validate the actual TLS, CORS, reverse proxy, system proxy, and sleep/wake behavior.
- Enable only one writer device per synchronized Vault.
- Do not let multiple ingress transports write the same queue unless the downstream workflow is independently idempotent.
- Preserve state files on failure; do not delete them as a routine recovery step.

The plugin does not execute ntfy actions or click targets, does not delete Vault content in response to remote mutations, and does not promise distributed exactly-once delivery or recovery beyond the server cache window.
