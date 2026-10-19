# Distribution

This document covers releases of [viveksjain/codiff](https://github.com/viveksjain/codiff).
The upstream [nkzw-tech/codiff](https://github.com/nkzw-tech/codiff) releases and Homebrew tap
are separate. Publishing a fork release does not update upstream's downloads or cask.

## Native Apps

Codiff uses Electron Forge at the repository root:

- App bundle ID: `dev.nkzw-tech.codiff`
- Product name: `Codiff`
- URL scheme: `codiff`

Build commands:

```sh
vpr make
vpr make:ci
vpr make:mac
```

`vpr make:mac` builds the workspace packages and renderer, then runs the Apple Silicon build:

```sh
electron-forge make --platform=darwin --arch=arm64
```

For a signed and notarized macOS build, export your Apple environment variables before running
`vpr make:mac`:

```sh
export APPLE_ID='apple-id@example.com'
export APPLE_PASSWORD='app-specific-password-or-keychain-profile'
export APPLE_TEAM_ID='TEAMID12345'
export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID12345)'
vpr make:mac
```

The signing certificate must already be present in the local keychain. If `APPLE_SIGNING_IDENTITY` is omitted, Electron's signing tooling may choose a matching Developer ID identity automatically, but setting it explicitly is less ambiguous.

## GitHub Actions

[`.github/workflows/build-app.yml`](../.github/workflows/build-app.yml) builds Linux packages on
Ubuntu and the Windows ZIP on a native Windows runner. macOS builds are local-only because
they require a Developer ID certificate in the local keychain.

Pushing a version tag creates a draft release, builds Linux and Windows assets, and publishes
the release when both jobs succeed. Tags must be `v` plus the checked-out `package.json` version.
The workflow uploads assets to the repository where it runs, so runs in this fork publish to
`viveksjain/codiff`.

To rebuild assets for an existing release, push any fixes first, then dispatch the workflow:

```sh
gh workflow run build-app.yml --repo viveksjain/codiff --ref main \
  -f release_tag=v2.0.0 -f platform=windows
```

`platform` accepts `windows`, `linux`, or `all`. `--ref` selects the code to build; `release_tag`
selects the existing release, and must match `v` plus that ref's `package.json` version. Manual
runs replace matching assets for the selected platforms without creating or publishing a release.
Monitor the run through completion and verify its assets on the requested release:

```sh
gh run list --repo viveksjain/codiff --workflow build-app.yml --limit 5
gh run watch <run-id> --repo viveksjain/codiff --exit-status
gh release view v2.0.0 --repo viveksjain/codiff --json assets
```

## App-Specific Setup

Use an Apple account, team, and Developer ID certificate that you control or are authorized to use.

These parts are app-specific:

- `dev.nkzw-tech.codiff` must be the bundle ID you want to use for Codiff.
- Codiff includes `electron/icons/icon.icns`, `electron/icons/icon.ico`, and `electron/icons/icon.png`. The Forge config uses these automatically, and the source Icon Composer document lives at `electron/icons/Codiff.icon`.
- Release asset hosting URLs are app-specific. For Homebrew, the macOS zip needs a stable HTTPS URL.
- The fork has no built-in update checker or installer. Users install new releases manually
  or pull and rebuild their source checkout.

## Manual macOS Release Flow

Build, sign, and notarize the macOS app locally. The signed zip should be in:

```sh
out/make/zip/darwin/arm64/Codiff-darwin-arm64-<version>.zip
```

The zip must also be uploaded to the matching GitHub Release in
`viveksjain/codiff` and be available at the stable public URL:

```sh
https://github.com/viveksjain/codiff/releases/download/v<version>/Codiff-darwin-arm64-<version>.zip
```

Upload the ZIP to the existing release if it is not already attached:

```sh
gh release upload v<version> \
  out/make/zip/darwin/arm64/Codiff-darwin-arm64-<version>.zip \
  --repo viveksjain/codiff
```

If the release is still a draft, publish it when the intended platform assets are ready:

```sh
gh release edit v<version> --repo viveksjain/codiff --draft=false --latest --title v<version>
```

Verify the release asset URL and checksum:

```sh
curl -L --fail --output /tmp/Codiff-darwin-arm64-<version>.zip \
  https://github.com/viveksjain/codiff/releases/download/v<version>/Codiff-darwin-arm64-<version>.zip
shasum -a 256 out/make/zip/darwin/arm64/Codiff-darwin-arm64-<version>.zip
shasum -a 256 /tmp/Codiff-darwin-arm64-<version>.zip
```

## Homebrew

The [nkzw-tech/homebrew-tap](https://github.com/nkzw-tech/homebrew-tap) cask installs upstream
Codiff. Use the fork's release ZIP or build from source to get this fork's features.

If distributing the fork through a separate tap, use a cask for the prebuilt `.app`. Set its
download URL and homepage to this fork, and update `version` and `sha256` from the published ZIP.
Run audit and style checks through that tap's checkout before pushing:

```sh
cd "$(brew --repository <owner>/<tap>)"
brew audit --cask <owner>/<tap>/codiff
brew style --cask <owner>/<tap>/codiff
```

## Terminal Helper

The upstream cask symlinks Codiff's packaged terminal helper as `codiff`. Running
`codiff` from a repository opens that folder, and running
`codiff /path/to/repo` opens the provided folder without keeping the terminal
attached to the Electron process. `codiff --share` runs the bundled CLI
headlessly, waits for walkthrough generation and upload, and prints the final
URL without opening an Electron window.

Users who install the `.app` directly can run `Codiff > Install Terminal Helper`
from the app menu. Codiff installs the helper into the first writable location
from `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin`.
