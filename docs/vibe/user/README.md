# Vibecodium User Guide

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-27

Vibecodium is not released yet. This guide grows with each milestone; every section states whether the feature is available.

| Topic | Available | Milestone |
|---|---|---|
| Install from the `.exe` or the portable zip | not yet | M12 (test builds from M0) |
| Use chat, inline chat, the Agents window and sessions without a GitHub account | not yet (surfaces enabled; model wiring pending) | M1 A2 removes Copilot and keeps the sign-in prompts off, and a real extension host (the installed VS Code host; the built app cannot start under this host ACL, so a rebuilt-app smoke remains M12) proves the chat, inline-chat, Agents, session and checkpoint commands are present on a throwaway profile whose extensions directory starts empty, with no user-installed Copilot extension (this proves the surfaces and classifier wiring, not the owner's normal profile; the test disables the stock host's built-ins by exact id, the runner asserts an empty user-installed list with a planted probe, and the build removes the bundled `extensions/copilot` folder; a stock host may still list or load its own bundled Copilot Chat); model and provider wiring is M2, so requests are not useful yet |
| Set up model providers with point-and-click | not yet (the provider setup panel, environment-variable key picker and Windows Credential Manager storage landed; the workbench does not connect the setup service yet, and Bifrost supervision is pending) | M2 |
| Set up the local runtime on first run | not yet (the wizard core, install state, progress flow, setup panel, supervisor runtime options with the bounded restart policy, Ollama detection and the pinned sidecar install in the start action landed; the wizard can select a detected daemon as the local runtime, and the start action installs and verifies the pinned llama.cpp runtime when no binary is supplied, into the installer-owned application data directory when the host supplies `sidecar.appDataRoot` (otherwise the `<destinationDir>/runtime` default still applies), while copying the binary into the packaged application and the live smoke remain, and the workbench does not connect the wizard yet) | M3 |
| Use an existing local Ollama install | not yet (the discovery module, the first-run detection and explicit selection, and the B1 `ollama` preset contract landed; no live-daemon smoke has run yet, and the provider setup panel does not call the discovery yet, so the daemon can be selected in the wizard but is not activated from the provider panel) | M3 |
| Index and graph several projects | not yet | M5 standalone cross-project edge layer and graph panel core landed; the panel opens in the editor area and renders in a real VS Code extension host; a node click opens the source (the acceptance used the installed VS Code host; the built app cannot start under this host ACL); M6 live workspace/index binding is outstanding (M4 index engine accepted) |
| Memory and long context | not yet | M5 context engine and memory review panel landed; the panel renders and approves a fact in a real VS Code extension host, and a second session recalls it; a full in-app build and M6 IDE binding are outstanding |
| Look up library documentation through an agent tool | not yet | M5 local docs MCP server landed with bounded list/search/read tools over explicitly configured Markdown roots; Bifrost and in-IDE wiring are later integration work |
| Prompt Studio (long prompt → approved spec) | not yet | M9 |
| Autonomous agents and the autonomy dial | not yet | M6–M8 |
| Built-in docs, locks and guardians for your own projects | not yet | M9 |
