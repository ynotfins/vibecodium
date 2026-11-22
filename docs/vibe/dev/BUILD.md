# Building Vibecodium on Windows

> Doc class: living - Owner: docs-keeper - Last reviewed: 2026-11-22

Vibecodium builds with VSCodium's scripts. Run everything in **Git Bash** from the repository root.

## 1. Toolchain

| Tool | Version | Notes |
|---|---|---|
| Git for Windows | any current | Provides Git Bash |
| Node.js | exactly the version in `.nvmrc` | A portable Node folder works; point `VIBE_NODE_HOME` at it |
| Python | 3.11.x | Used by node-gyp; point `VIBE_PYTHON` at it if `py -3.11` is not available |
| jq, 7-Zip | any current | 7-Zip is found in `C:\Program Files\7-Zip` automatically |
| Rust | stable via rustup | |
| Visual Studio Build Tools | 2022 with the C++ workload | |
| MSVC Spectre-mitigated libraries | component `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre` | Required by VS Code's native modules (MSB8040 without it). Install from an **elevated** PowerShell, see below |

If the Spectre libraries are missing, add them (one time, needs administrator rights):

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe" modify --installPath "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools" --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --passive --norestart
```

Check everything:

```bash
bash vibe/dev/preflight.sh
```

Every line must say `PASS`. *Verified 2026-11-20 (all PASS, including `spectre`).* The `spectre` component is installed on the build workstation.

## 2. Build

### Brand icons

The source vectors are `icons/<quality>/vibe_*.svg`. The checked-in overlay icons under `src/stable/resources/` (Windows app and Inno artwork, Linux, server, and the workbench icon) are generated from those vectors. `bash icons/build_icons.sh` regenerates any missing icon asset (delete an existing target to force a re-render); it requires ImageMagick, librsvg, png2icns, icotool and coreutils `mktemp`; `docs/howto-build.md` describes the upstream icon toolchain. The regeneration command was not executed in this slice because the renderer toolchain (rsvg-convert, png2icns, icotool) is not installed in the loop environment; the checked-in outputs and the contract test are verified. The icon contract test verifies the vectors, the build script's local-only sources, and the shipped overlay dimensions:

```bash
node --test tests/vibe/icon-assets.test.mjs
```

### Context engine: summary DAG

The standalone Vibe Context Engine builds a leaf-and-condensed summary DAG over the lossless session records and keeps the newest records in a protected fresh tail. Summaries are model-agnostic: the caller supplies a summarizer, so the engine does not depend on a provider, network connection, or IDE build. The DAG object exposes bounded `grep`, `describe`, and `expand` tools; `grep` is a case-insensitive literal substring search (no caller-supplied regular expressions), `list` and `expand` paginate, and content-bearing results carry `sourceTrust: untrusted-session-content` for later quarantine. `expand` pages through the original records inside a summary node without rewriting the append-only transcript.

The contract test builds a 210-turn session, finds a detail stored at record sequence 5 with `grep`, and retrieves it through `expand`; it also proves that `expand` returns only summarized records and that `grep` excludes the fresh tail unless `includeTail` is requested:

```bash
node --test tests/vibe/context-engine.test.mjs
```

### Context engine: project and user memory

The standalone memory store persists facts across sessions in two scopes. User memory is global at `<root>/user/memory.jsonl`; project memory is isolated at `<root>/projects/<projectId>/memory.jsonl`. The store accepts JSON-safe values, serializes writes per scope within a store instance, and appends `put`, `review`, and `delete` events instead of rewriting the log. Repeating a key writes a new `put` with the same id and the next `revision`.

New and revised facts start as `pending`. `recall` returns approved facts only unless `includePending` is requested, in which case pending facts are included alongside approved facts; every returned entry carries `sourceTrust: untrusted-memory-content`. `review` defaults to the pending queue and can filter by `approved`, `rejected`, or `all`; `approve` and `reject` record decisions, and `forget` appends a deletion event. The review panel UI is not wired yet.

The store enforces hard caps: 20,000,000 bytes per log, 256,000 bytes per event, 10,000 live entries, 32 levels of value nesting, 200 characters for keys and queries, 16,000 characters for string values, and at most 500 items per review or recall page (default 100).

```bash
node --test tests/vibe/memory.test.mjs
```

### Update-feed manifests - local staging only

To prepare the platform-scoped `latest.json` files for the own update feed without publishing, create a release manifest containing the product fields and one entry per artifact:

```json
{
   "name": "Vibecodium",
   "version": "1.147.0",
   "commit": "<commit>",
   "date": "YYYY-MM-DD",
   "quality": "stable",
   "assets": [
      {
         "platform": "win32",
         "architecture": "x64",
         "target": "system",
         "path": "Vibecodium-x64-system.exe",
         "sha256": "<64-hex-checksum>",
         "size": 123456
      }
   ]
}
```

Run the generator against a non-public staging folder:

```bash
node vibe/tools/update-feed.mjs --manifest release.json --out ../update-feed-staging --asset-url-root https://releases.example.com/vibecodium/1.147.0
```

The generator validates the update-service fields, requires a SHA-256 checksum and size for every artifact, emits `sha256hash`, and writes one manifest per quality/platform/architecture combination, with an extra target segment for Windows installer and archive assets. `version` follows the updater contract as the commit and `productVersion` as the semver product version. It does not upload or publish anything.

The stable and insider Windows publish workflows check out the product tooling from `vibe/main` and run `node vibecodium-tooling/vibe/tools/release-feeds.mjs` after checksum preparation. The tool reads the release asset directory and its `.sha256` sidecars, skips the updates-disabled MSI, and maps the remaining Windows assets to `system`, `user`, `archive`, and `msi` feeds. The workflows upload the resulting `latest.json` files as build artifacts named `update-feeds-<architecture>` for staged verification only; they do not upload feeds to a release or create a feed repository.

```bash
bash vibe/dev/build-windows.sh       # app only
bash vibe/dev/build-windows.sh -p    # app plus installer .exe and zip (not yet verified in this slice)
```

After a stable `-p` build, verify the Windows system installer, user installer, and portable zip:

```bash
source dev/build.env
node vibe/tools/windows-packaging-smoke.mjs --assets assets \
   --name Vibecodium \
   --version "$RELEASE_VERSION" \
   --commit "$BUILD_SOURCEVERSION"
```

Run this in Git Bash with 7-Zip on `PATH` (source `vibe/dev/preflight.sh` in the same session; it adds `C:\Program Files\7-Zip` when present). `dev/build.sh` writes the generated `RELEASE_VERSION` and the stamped `BUILD_SOURCEVERSION` to `dev/build.env`. `--commit` is the value the build stamps into `resources/app/product.json`; it is `BUILD_SOURCEVERSION`, not the upstream VS Code commit (`MS_COMMIT`).

The command fails if any required artifact is missing, if a SHA-256 cannot be computed, if `7z` cannot list or extract the portable zip, or if the packaged app does not carry the expected Vibecodium name, version, commit, executable, launcher, and product metadata. It does not install anything.

*Verified 2026-11-20 for the app-only build on the build workstation (preflight PASS including `spectre`; full build from clean clone through `npm ci`, native modules, compile and `vscode-win32-x64-min-packing`, producing `VSCode-win32-x64/` in the repository root, branded as Vibecodium).* The wrapper runs the preflight, pins node-gyp to Python 3.11 and calls `dev/build.sh` with the same flags. The `-p` installer/zip smoke remains pending. Output appears in the repository root (`VSCode-win32-x64/`, beside the `vscode` checkout).

## 3. Checks before committing

```bash
node vibe/tools/verify.mjs
```

*Verified 2026-11-20; also run by CI and covered by `tests/vibe/`.*

## 4. Upstream sync

`master` mirrors `VSCodium/vscodium`. To take a new upstream release (*not yet verified; first exercised at the first upstream release after M0*):

```bash
git fetch upstream
git checkout master && git merge --ff-only upstream/master
git checkout vibe/main && git merge master
node vibe/tools/verify.mjs && bash vibe/dev/build-windows.sh
```
