# Security

> Doc class: living · Owner: security-reviewer · Last reviewed: 2026-11-20

## Model

- Secrets are stored only in OS secret storage (Electron `safeStorage`, DPAPI on Windows) or OS environment variables. They are never written to files, logs, prompts, traces or commits.
- All agent shell commands run inside the sandbox (sandbox-runtime) once M6 lands. Auto-approve rules are convenience, not a security boundary.
- Planned for M6: untrusted content (web pages, MCP tool output, files from the internet) is tagged and summarized by a tool-less model before a privileged agent acts on it.
- Shipped artifacts contain only permissive licenses; see `ARCHITECTURE.md` principle 8.
- Bundled binaries are pinned by SHA-256 and signed once a signing route is chosen.

## Build loop

The autonomous build loop's isolation and accepted risks are documented in `GOVERNANCE.md` §5 "Enforcement".

## Reporting

Until a public security contact exists, report issues privately to the repository owner through GitHub. Do not open public issues for vulnerabilities.
