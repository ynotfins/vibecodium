# Update feed

The packaged app reads update manifests from

`https://raw.githubusercontent.com/ynotfins/vibecodium/refs/heads/vibe/main/update-feed`

using the contract in `patches/11-update-use-github-release.patch`:
`<quality>/<platform>/<architecture>[/<target>]/latest.json`.

`vibe/tools/update-feed.mjs` and `vibe/tools/release-feeds.mjs` write those same relative
paths. The M12 release job will be the only writer. This directory intentionally holds no manifests
in the repository until the first draft release publishes them: a hand-written
`latest.json` would offer users a wrong or unverified download.

The download page for a stable build is `https://github.com/ynotfins/vibecodium/releases`.
A local insider build (`dev/build.sh -i`) targets the branded
`ynotfins/vibecodium-insiders` repository, matching the primary CI value
`${repository}-insiders`. That repository does not exist yet; the upstream winget job
still hardcodes the VSCodium insider repository (`VSCodium/vscodium-insiders`), and
creating/wiring the branded insider repository is release work (M12) and is out of
scope here.
