# AGENTS.md — AI contributor guide

This repo is a single-script, zero-dependency Node.js CLI that patches an installed GenOffice (Electron) app to route its `custom` AI provider at OpenCode Zen/Go OpenAI-compatible endpoints.

## Tracked layout

- `patch-genoffice.mjs` — entire tool (CLI + asar reader/writer + patch + restore + status). ESM (`type: module`), Node >= 18.
- `package.json` — name `opencode-for-genoffice`, version `1.1.0`, bin `ocfgo` -> `patch-genoffice.mjs`. `files` ships only `patch-genoffice.mjs`, `README.md`, `LICENSE`.
- `README.md` — user docs (usage, providers/models, install paths, update flow).
- `LICENSE` — GPL-3.0.
- `.gitignore` — `node_modules/`, `*.log`, `.DS_Store`.
- `dev/` is gitignored (`dev/.gitignore` = `*`). Do not document it, import from it, or assume it exists in clones.

## Commands

```bash
node patch-genoffice.mjs patch --api-key <key> [--provider zen|go] [--model <id>] [--base-url <url>] [--ua <ua>] [--header "N: V"] [--install-dir <d>] [--user-data <d>] [--backup-dir <d>] [--dry-run] [--yes]
node patch-genoffice.mjs patch --ua "..." --header "x-k: v"   # BYOK generation (0.7.793+), headers-only
node patch-genoffice.mjs status
node patch-genoffice.mjs restore
npm run patch | npm run restore | npm run status
```

Global install adds `ocfgo` (same args). Always support `--dry-run` (no writes), `--yes/-y` (skip prompt), `--help/-h`. Unknown flags/commands exit 2.

## Two generations (auto-detected per install)

`detectGeneration(asarPath, resourcesDir)` reads `out/main/index.js` from `app.asar`:

- Content probe first: `settings.provider = "genspark";` present = `legacy`; `settings.provider = activeProvider(settings);` present = `byok`.
- Fallback: `installedAppVersion()` (asar `package.json`, else `app-update.yml`) vs `0.7.793` via `compareVersions()`. Returns `null` if undeterminable (caller assumes legacy with warning).

Legacy (<=0.7.686): full flow in `cmdPatch` — backup, remove force-reset, UA hook + webRequest rewrite + reasoning pipeline, patch renderer bundles, `writeAiSettings` (key/model/baseUrl + userAgent).

BYOK (>=0.7.793): headers-only flow in `cmdPatchByok` — `patchMainJsHeaders` (chat streaming turn + non-streaming chat + shared media `bearer()` + webRequest rewrite), `writeAiSettingsHeaders` (merge `headers` only; key/model/baseUrl untouched). `--api-key/--model/--base-url/--provider` are ignored.

## Code map (`patch-genoffice.mjs`)

- Constants: `PROVIDERS` (zen/go baseUrl+model+modelsUrl), `DEFAULT_PROVIDER='zen'`, `PKG_VERSION`/`DEFAULT_UA` (read from local `package.json`, fallback `0.0.0`), `NEEDLE`, `MAIN_JS='out/main/index.js'`, `AI_SETTINGS_FILE`.
- Anchor/code pairs: `UA_ANCHOR`+`UA_ANCHOR_STREAM`, `WEBREQ_*`, `REASONING_*`, `MAIN_REASONING_*` (8 steps), `REN_*` (renderer), `HDR_ANCHOR_STREAM`/`HDR_ANCHOR_CHAT`/`HDR_ANCHOR_BEARER`/`HDR_WEBREQ_*`, `BYOK_MARKER`.
- asar (exported, self-contained): `readAsarHeader`, `extractAsar`, `packAsar` (drops `integrity` fields — OK, fuses have validation disabled), `readFileFromAsar` (single-file read; descend via `node.files`).
- Platform: `detectInstall` (win32/darwin/linux candidates), `resolveInstall` (accepts app root or `resources/`), `detectUserDataDir`, `isGenOfficeRunning` (`tasklist` on win32, `pgrep -f [/]GenOffice` elsewhere). Refuse patch/restore while running.
- State probes: `isPatched` (null = unreadable), `isUaInjected`, `isWebReqInjected`, `isReasoningInjected`, `isHeadersInjected` (all 4 BYOK injections), `rendererBundles`/`rendererBundlePatched`/`renderersPatched` (true/false/null = none found).
- Patch: `patchMainJs` (legacy), `patchMainJsHeaders` (BYOK, exported), `patchRendererBundle`/`patchAllRenderers`/`backupRenderers` (exported bundle helpers).
- Settings: `writeAiSettings` (legacy full overwrite of `providers.custom`), `writeAiSettingsHeaders` + `dedupeHeaders` + `hasAnyHeaders` (BYOK merge into `providers.custom.headers` + `media.providers.custom.headers`; `--ua ""` removes; first run seeds default UA).
- Backup: `backupExisting`, `backupDirFor` (default `<resources>/backups`), `manifest.json` via `readManifest`/`writeManifest`, `latestBackup`. Re-patches keep the original backup as restore point (`asarBackup: null` in manifest).
- CLI: `parseArgs` (provider defaults resolved AFTER loop so explicit flags win; invalid provider exits 2), `printHelp`, `cmdPatch`/`cmdPatchByok`/`cmdRestore`/`cmdStatus`, `main` (runs only when executed directly).

## Patching conventions

- Anchor-based string replacement only (`split(anchor).join(code)`). Anchors are exact bundle bytes; if an anchor is missing, `warn` and continue — never silently break or throw, except syntax-check failure (`fail`).
- All injections idempotent and marker-guarded (check `*_MARKER`/`*_CODE` presence before applying).
- Skip-asar fast path: legacy skips extract/patch/repack when force-reset gone AND UA hook AND webRequest AND reasoning present (settings-only update). BYOK skips when `isHeadersInjected`. Missing pieces re-patch WITHOUT new backup.
- Syntax check before write: main JS via `new Function(out)`; renderer bundles via `node --check` on a temp `.mjs` (they are ESM).
- JS gotcha: `{ ...cond ? a : b }` is a syntax error — always parenthesize: `{ ...(cond ? a : b) }`.
- Bearer anchor excludes the fn closing brace — replacement must not add one.
- Header-name dedupe is case-insensitive (`dedupeHeaders`, `User-Agent` canonical first); `--header` parsing requires `Name: value` form.
- `baseUrl` stored without trailing slash (code appends `/chat/completions`).
- Renderer bundles live OUTSIDE the asar (`resources/modules/<app>/renderer/assets/index-*.js`); GenOffice updates wipe them. `patch` re-injects, `restore` reverts from `.bak-*`, `status` reports `renderer capture`.
- Chromium `net.fetch` rescue path silently drops `User-Agent` from fetch headers — the `webRequest.onBeforeSendHeaders` rewrite is required, not optional.

## Install / user-data paths

- Windows: `%LOCALAPPDATA%\Programs\GenOffice` / `%APPDATA%\GenOffice`.
- macOS: `/Applications/GenOffice.app/Contents/Resources` / `~/Library/Application Support/GenOffice`.
- Linux: `/opt/GenOffice`, `/usr/lib/genoffice`, `~/.local/share/GenOffice`, snap/flatpak / `~/.config/GenOffice`. May need `sudo`.
- Overrides: `--install-dir`, `--user-data`, `--backup-dir`.

## Common tasks

- New GenOffice version breaks anchors: run `status`, extract `out/main/index.js` via `readFileFromAsar`, locate the moved block, update the `*_ANCHOR` constant only (keep `*_MARKER` stable if possible). Same for renderer `REN_*` anchors.
- New CLI option: add to `parseArgs` + `printHelp` + header comment + `README.md` options table. Repeatable options accumulate (see `--header`).
- Default model/URL change: edit `PROVIDERS` only; `DEFAULT_UA` tracks `package.json` version automatically.
- No test suite. Validate with: `node --check patch-genoffice.mjs`, `patch --dry-run`, and `patch`/`status`/`restore` against a temp `--user-data` dir plus a copied install dir.

## Do not

- Do not add dependencies (must stay zero-dep, Node >= 18 only).
- Do not store keys/models/URLs in code; they live in `ai-settings.json`.
- Do not create new backups on re-patch; keep the original as restore point.
- Do not touch `dev/` (gitignored, absent in clones/packs).
- Do not use `:` in backup timestamps (invalid on Windows NTFS ADS).
