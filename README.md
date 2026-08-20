# OpenCode for GenOffice

<picture>![Badge Repo Size]</picture>
[![Badge License]](./LICENSE)
[![Badge OpenCode]](https://opencode.ai)
[![Badge GenOffice]](https://github.com/genspark-ai/genoffice/releases/tag/v0.7.512)

Cross-platform tool that points an installed **GenOffice** at OpenCode **Zen** or **Go** models via an [OpenAI chat-completions](https://developers.openai.com/api/reference/chat-completions/overview) compatible endpoint, using your own API key.

Works on **Windows, Linux, and macOS**. Requires only **Node.js >= 18** — no other
dependencies (the asar reader/writer is built in).

<br/>

## What it does

GenOffice has no `OPENAI_BASE_URL`-style env var. Its built-in `custom` provider already
appends `/chat/completions` to any `baseUrl` and sends `Authorization: Bearer <key>`, but
the `ai:get-settings` IPC handler force-resets the provider to `genspark`.

This tool:

1. **Backs up** `app.asar` (and `ai-settings.json` if present) into
   `<install>/resources/backups/` with a timestamp.
2. Extracts `app.asar`, removes the `settings.provider = "genspark";` line(s) from
   `out/main/index.js`, injects a config-driven User-Agent hook into the `custom`
   provider's request headers, injects a `reasoning_content` passthrough in
   `openAiMessages` (required by thinking-mode models), repacks, and replaces the
   installed asar.
3. Writes/merges `ai-settings.json` in the GenOffice user-data dir selecting the
   `custom` provider with your key, model, and base URL.
4. `restore` puts everything back from the backup.

Verified on the real v0.7.x bundle: the patched `out/main/index.js` is byte-identical
to the original except the removed force-reset lines, and the repacked asar is readable
by standard asar tooling. The app's Electron fuses have asar-integrity validation
**disabled**, so the patched asar loads normally.

<br/>

## Installation

> [!IMPORTANT]  
> **GenOffice must already be installed** — this tool patches the installed app, it does
not install GenOffice itself.

Requires **Node.js >= 18** — no other dependencies (the asar reader/writer is built in).

```bash
# Clone the repo and enter it
git clone --depth 1 https://github.com/sekedus/opencode-for-genoffice.git
cd opencode-for-genoffice

# Option 1: run directly from the repo (no install needed)
node patch-genoffice.mjs <command> [options]

# Option 2 (optional): install globally, adds the `ocfgo` command
npm install -g .
```

## Usage

```
node patch-genoffice.mjs <command> [options]

# or, if installed globally (Option 2):
ocfgo <command> [options]
```

### Commands

| Command   | Description |
|-----------|-------------|
| `patch`   | Apply the patch (default). Automatically backs up first. |
| `restore` | Restore the original `app.asar` from the latest backup. |
| `status`  | Show install location, patch state, and available backups. |

### Options

| Option | Description |
|--------|-------------|
| `--provider <zen\|go>` | Endpoint provider (default: `zen`). `zen` = pay-per-use, `go` = subscription. |
| `--api-key <key>` | OpenCode API key, Zen or Go (required for `patch`) |
| `--model <model>` | Model id (default: `big-pickle` for zen, `deepseek-v4-pro` for go) |
| `--base-url <url>` | Base URL, no trailing slash (default: `https://opencode.ai/zen/v1` for zen, `https://opencode.ai/zen/go/v1` for go) |
| `--ua <ua>` | User-Agent header sent to the AI endpoint (default: `opencode-for-genoffice/<version>` from package.json) |
| `--install-dir <dir>` | GenOffice install dir (auto-detected if omitted) |
| `--user-data <dir>` | GenOffice user-data dir (auto-detected if omitted) |
| `--backup-dir <dir>` | Backup dir (default: `<install>/resources/backups`) |
| `--dry-run` | Show what would be done without changing anything |
| `--yes`, `-y` | Skip confirmation prompts |
| `--help`, `-h` | Show help |

### Examples

```bash
# Patch with defaults (big-pickle, Zen)
node patch-genoffice.mjs patch --api-key sk-xxxx

# Patch against OpenCode Go (subscription)
node patch-genoffice.mjs patch --api-key sk-xxxx --provider go

# Patch with a free model
node patch-genoffice.mjs patch --api-key sk-xxxx --model deepseek-v4-flash-free

# Patch with a custom User-Agent header
node patch-genoffice.mjs patch --api-key sk-xxxx --ua "opencode-for-genoffice/1.0.0"

# Go provider with a specific model
node patch-genoffice.mjs patch --api-key sk-xxxx --provider go --model glm-5.1

# Dry run first (no changes)
node patch-genoffice.mjs patch --api-key sk-xxxx --dry-run

# Check state
node patch-genoffice.mjs status

# Undo
node patch-genoffice.mjs restore
```

> [!NOTE]  
> If you installed globally (Option 2), the same commands work with `ocfgo` instead of
`node patch-genoffice.mjs`.

<br/>

## Install locations (auto-detected)

| OS | Install dir | User-data dir |
|----|-------------|---------------|
| Windows | `%LOCALAPPDATA%\Programs\GenOffice` | `%APPDATA%\GenOffice` |
| macOS | `/Applications/GenOffice.app/Contents/Resources` | `~/Library/Application Support/GenOffice` |
| Linux | `/opt/GenOffice`, `/usr/lib/genoffice`, `~/.local/share/GenOffice`, snap/flatpak paths | `~/.config/GenOffice` |

If auto-detection fails (e.g. a custom install path), pass `--install-dir` and
`--user-data` explicitly. On Linux, if the install dir is root-owned, run with `sudo`.

<br/>

## Models

Both providers serve OpenAI-compatible models via `/chat/completions` with
`Authorization: Bearer <key>`. The same API key works for Zen and Go — they are
part of the same platform (Zen is pay-per-use, Go is a fixed subscription).

### Zen (`--provider zen`, default)

Pay-per-use; includes free models. Chat-completions ids:

- Free: `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`,
  `laguna-s-2.1-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`
- Paid: `deepseek-v4-pro`, `deepseek-v4-flash`, `minimax-m3`, `minimax-m2.7`,
  `minimax-m2.5`, `glm-5.2`, `glm-5.1`, `glm-5`, `kimi-k2.5`, `kimi-k2.6`,
  `kimi-k2.7-code`, `kimi-k3`

Fetch the full list: `https://opencode.ai/zen/v1/models`

### Go (`--provider go`)

Fixed subscription ($5 first month, then $10/month), open-source models only.
Only the chat-completions models work with GenOffice's `custom` provider
(MiniMax/Qwen on Go use the Anthropic `/messages` dialect and are not supported
here). Chat-completions ids:

- `deepseek-v4-pro`, `deepseek-v4-flash`, `glm-5.3`, `glm-5.2`, `glm-5.1`,
  `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `mimo-v2.5`, `mimo-v2.5-pro`, `hy3`

Fetch the full list: `https://opencode.ai/zen/go/v1/models`

<br/>

## How the patch works (technical)

- The code change in `out/main/index.js` inside `resources/app.asar` is:
  1. Remove `settings.provider = "genspark";` (2 occurrences in v0.7.512: the active
     `ai:get-settings` handler and a dormant sheets variant).
  2. Inject a config-driven User-Agent hook into the `custom` provider's fetch headers
     in **both** request paths (the non-streaming chat call and the streaming turn the
     AI panel actually uses):
     `...(config2.userAgent ? { "User-Agent": config2.userAgent } : {})`. The value is
     read from `ai-settings.json`, so `--ua` can be changed by re-running `patch`
     without touching the asar again.
  3. Register a `webRequest.onBeforeSendHeaders` handler that rewrites the `User-Agent`
     header for `/chat/completions` requests. This is required because GenOffice's AI
     requests can fall back to Chromium's `net.fetch` (when Node's fetch fails at the
     network layer, e.g. under VPN/proxy), and Chromium silently drops a `User-Agent`
     header set in fetch headers — it sends its own Electron UA instead. The handler
     reads the UA from `ai-settings.json` at request time.
  4. Inject a `reasoning_content` passthrough in `openAiMessages`: assistant history
     turns now include
     `...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {})`.
     Thinking-mode providers (DeepSeek, Qwen, Kimi, GLM) require the previous
     assistant's `reasoning_content` to be echoed back on follow-up requests that
     carry tool calls, or they reject the turn with HTTP 400 ("The `reasoning_content`
     in the thinking mode must be passed back to the API"). The renderer bundles
     capture streaming `reasoning_content` into history; this injection forwards it
     when the patched renderer is present.
- `resolveAiSettings()` already honors a stored `provider`/`providers`, so once the
  force-reset is gone, `provider: "custom"` from `ai-settings.json` is used.
- The `custom` provider builds `POST {baseUrl}/chat/completions` with
  `Authorization: Bearer <apiKey>` — exactly the OpenCode Zen shape.
- `ai-settings.json` is merged: existing providers are preserved, `custom` is
  set/overwritten, and `provider` is set to `custom`. `userAgent` defaults to
  `opencode-for-genoffice/<version>` (from package.json); pass `--ua` to override it.
- Re-running `patch` on an already-patched install skips all asar work (the original
  backup stays the restore point) and only rewrites `ai-settings.json`. If the asar is
  patched but missing the User-Agent or reasoning-echo support (e.g. patched by an
  older version), it is re-patched to add it without creating a new backup.

<br/>

## Updating GenOffice

GenOffice updates replace the installed app files, which **overwrites the patched
`app.asar`** — the patch must be re-applied after every update. Your data (the
user-data dir with `ai-settings.json`) is preserved by the update, so your provider,
key, model, and base URL carry over. This applies the same way on Windows, Linux,
and macOS (see the install locations table above for the per-OS paths).

### What you need to update

| Component | Needed? | Why |
|-----------|---------|-----|
| Installed app | **Yes** | This is what runs. Update it (auto-update or new installer), then re-patch. |
| User-data dir | **No** | Preserved automatically by the update. `ai-settings.json` survives. |

### Steps

1. **Close GenOffice** — the tool refuses to run while the app is open.
2. **Update the app** — let it auto-update, or install the new version over the
   existing one (same install dir).
3. **Re-run the patch** with your usual flags:

   ```bash
   ocfgo patch --api-key sk-xxxx
   ```
   The tool detects the fresh (unpatched) asar, backs it up, and re-applies the patch.
   Your `ai-settings.json` is merged/rewritten automatically.
4. **Restart GenOffice** and verify the AI panel works.

### Caveats

- **Old backups become stale.** After an update, re-running `patch` creates a new
  backup of the *new* original asar, so `restore` stays correct for the new version.
- **Version drift.** If a new version changes the bundle (renamed functions, moved
  code), the patch anchors may not match. The tool warns instead of silently breaking
  ("Could not find...", "unsupported version"). In that case, extract the new
  `app.asar` and update the anchors in `patch-genoffice.mjs` — this is the only
  scenario where the source code matters.
- **Auto-update is the main hazard** — it can silently replace `app.asar` at any time.
  Consider disabling the updater or scripting the re-patch.

<br/>

## Notes & caveats

- **Close GenOffice before patching/restoring.** The tool refuses to run while the app
  is running (file locks on Windows).
- **Auto-updates overwrite `app.asar`.** After a GenOffice update, re-run the patch
  (see [Updating GenOffice](#updating-genoffice)).
- `restore` uses the latest backup. Backups are timestamped and kept in
  `<install>/resources/backups/` (plus a `manifest.json` history).
- The app is not digitally signed and has asar-integrity validation disabled, so the
  patched asar loads without issue.
- This is an unofficial modification. Verify the OpenCode Zen terms of service and your
  API key before use.

<br/>

## License

This project is licensed under the GPL-3.0 License - see the [LICENSE](./LICENSE) file for details.


<!-- Badges -->

[Badge Repo Size]: https://img.shields.io/github/repo-size/sekedus/opencode-for-genoffice?label=Size
[Badge License]: https://img.shields.io/github/license/sekedus/opencode-for-genoffice?label=License
[Badge OpenCode]: https://img.shields.io/badge/OpenCode-000000.svg?logo=opencode
[Badge GenOffice]: https://img.shields.io/badge/GenOffice-v0.7.512-0D7EFE.svg?labelColor=000000&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNDggMTQ4Ij4KPGc+CjxyZWN0IHdpZHRoPSI5MCIgaGVpZ2h0PSIxMDgiIGZpbGw9IndoaXRlIiByeD0iMTYiLz4KPHJlY3QgeD0iNDgiIHk9IjQwIiB3aWR0aD0iOTAiIGhlaWdodD0iMTA4IiByeD0iMTYiIGZpbGw9IndoaXRlIi8+CjxwYXRoIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgZD0iTTQ4IDU2QzQ4IDQ3LjE2MzQgNTUuMTYzIDQwIDY0IDQwSDkwVjkyQzkwIDEwMC44MzcgODIuODM3IDEwOCA3NCAxMDhINDhWNTZaIiBmaWxsPSJibGFjayIvPgo8L2c+Cjwvc3ZnPg==
<!-- [Badge GenOffice]: https://img.shields.io/badge/GenOffice-v0.7.512-0D7EFE.svg?labelColor=ffffff&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMzggMTQ4Ij4KPGc+CjxyZWN0IHdpZHRoPSI5MCIgaGVpZ2h0PSIxMDgiIGZpbGw9ImJsYWNrIiByeD0iMTYiLz4KPHJlY3QgeD0iNDgiIHk9IjQwIiB3aWR0aD0iOTAiIGhlaWdodD0iMTA4IiByeD0iMTYiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgZD0iTTQ4IDU2QzQ4IDQ3LjE2MzQgNTUuMTYzIDQwIDY0IDQwSDkwVjkyQzkwIDEwMC44MzcgODIuODM3IDEwOCA3NCAxMDhINDhWNTZaIiBmaWxsPSJ3aGl0ZSIvPgo8L2c+Cjwvc3ZnPg== -->
