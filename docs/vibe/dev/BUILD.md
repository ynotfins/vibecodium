# Building Vibecodium on Windows

> Doc class: living - Owner: docs-keeper - Last reviewed: 2026-11-21

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

```bash
bash vibe/dev/build-windows.sh       # app only
bash vibe/dev/build-windows.sh -p    # app plus installer .exe and zip (not yet verified in this slice)
```

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
