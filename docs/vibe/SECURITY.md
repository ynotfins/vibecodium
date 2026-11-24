# Security

> Doc class: living · Owner: security-reviewer · Last reviewed: 2026-11-24

## Model

- Secrets are stored only in OS secret storage (Electron `safeStorage`, DPAPI on Windows) or OS environment variables. They are never written to files, logs, prompts, traces or commits.
- All agent shell commands run inside the sandbox (sandbox-runtime) once M6 lands. Auto-approve rules are convenience, not a security boundary.
- Outbound AI requests are decided by the deny-by-default policy core in `src/stable/security/ai-endpoint-policy.mjs`: local model servers are allowed, and Microsoft, GitHub Copilot, telemetry, model-catalog and upstream update hosts are refused until a caller explicitly opts in. See `docs/vibe/design/m1-endpoint-audit.md`. Cloud-metadata hostnames and addresses enumerated in the policy core and the whole IPv4/IPv6 link-local ranges are hard-denied and cannot be enabled by any switch; IPv6 unique-local addresses are not auto-allowed and require an exact host or host+path allow; mDNS `.local`/`.localhost` aliases are re-checked against the same hard-deny set; the whole local-use NAT64 range and the IPv4 metadata addresses embedded in the well-known NAT64 range are hard-denied. The live fetch interception is M2/M6 wiring.
- Planned for M6: untrusted content (web pages, MCP tool output, files from the internet) is tagged and summarized by a tool-less model before a privileged agent acts on it.
- Shipped artifacts contain only permissive licenses; see `ARCHITECTURE.md` principle 8.
- Bundled binaries are pinned by SHA-256 and signed once a signing route is chosen.

## Build loop

The autonomous build loop's isolation and accepted risks are documented in `GOVERNANCE.md` §5 "Enforcement".

## Reporting

Until a public security contact exists, report issues privately to the repository owner through GitHub. Do not open public issues for vulnerabilities.
