#!/usr/bin/env node
/**
 * patch-genoffice.mjs
 *
 * Point an installed GenOffice (Electron) at an OpenAI-compatible endpoint.
 * Providers: OpenCode Zen  https://opencode.ai/zen/v1/chat/completions
 *            OpenCode Go   https://opencode.ai/zen/go/v1/chat/completions
 *
 * Cross-platform: Windows (Git Bash / cmd / PowerShell), Linux, macOS.
 * Requires: Node.js >= 18. No other dependencies (self-contained asar reader/writer).
 *
 * Commands:
 *   patch    Apply the patch (default). Automatically backs up app.asar first.
 *   restore  Restore the original app.asar from the latest backup.
 *   status   Show install location, patch state, and available backups.
 *
 * Options:
 *   --provider <p>      Endpoint provider: zen | go (default: zen)
 *   --api-key <key>     OpenCode API key, Zen or Go (required for patch)
 *   --model <model>     Model id (default: big-pickle for zen, deepseek-v4-pro for go)
 *   --base-url <url>    Base URL, no trailing slash (default: provider-specific)
 *   --ua <ua>           User-Agent header sent to the AI endpoint (default: opencode-for-genoffice/<pkg version>)
 *   --install-dir <d>   GenOffice install dir (auto-detected if omitted)
 *   --user-data <d>     GenOffice user-data dir (auto-detected if omitted)
 *   --backup-dir <d>    Backup dir (default: <install>/resources/backups)
 *   --dry-run           Show what would be done without changing anything
 *   --yes, -y           Skip confirmation prompts
 *   --help, -h          Show this help
 *
 * Examples:
 *   node patch-genoffice.mjs patch --api-key sk-xxxx
 *   node patch-genoffice.mjs patch --api-key sk-xxxx --provider go
 *   node patch-genoffice.mjs patch --api-key sk-xxxx --model deepseek-v4-flash-free
 *   node patch-genoffice.mjs restore
 *   node patch-genoffice.mjs status
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Provider presets. Both use the OpenAI chat-completions shape
// ({baseUrl}/chat/completions with Authorization: Bearer <key>).
// Zen = pay-per-use (free models included); Go = fixed subscription.
const PROVIDERS = {
  zen: {
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'big-pickle',
    modelsUrl: 'https://opencode.ai/zen/v1/models',
  },
  go: {
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4-pro',
    modelsUrl: 'https://opencode.ai/zen/go/v1/models',
  },
}
const DEFAULT_PROVIDER = 'zen'

// Default User-Agent tracks the package version from package.json (same dir as
// this script) instead of being hardcoded. Falls back to '0.0.0' if the file is
// missing (e.g. the script was copied out standalone).
const PKG_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
    ).version
  } catch {
    return '0.0.0'
  }
})()
const DEFAULT_UA = `opencode-for-genoffice/${PKG_VERSION}`
const NEEDLE = 'settings.provider = "genspark";' // exact bytes verified in v0.6.389 bundle
const MAIN_JS = 'out/main/index.js'
const AI_SETTINGS_FILE = 'ai-settings.json'

// User-Agent hook: inject a config-driven header into the custom provider's
// fetch call so --ua can be stored in ai-settings.json (updatable without
// re-patching the asar). The anchor is the unique chatOpenAiCompatible
// signature block; verified against the v0.6.389 bundle.
const UA_ANCHOR = `async function chatOpenAiCompatible(wd, baseUrl2, config2, system, user) {
  const response = await aiFetch(\`\${baseUrl2.replace(/\\/$/, "")}/chat/completions\`, {
    method: "POST",
    signal: wd.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${config2.apiKey}\`,`
const UA_LINE = `\n      ...(config2.userAgent ? { "User-Agent": config2.userAgent } : {}),`
const UA_NEEDLE = `...(config2.userAgent ? { "User-Agent": config2.userAgent } : {})`

// The AI panel streams responses, so the same hook must also go into the
// streaming turn (openAiCompatibleTurn), not just the non-streaming chat call.
const UA_ANCHOR_STREAM = `async function openAiCompatibleTurn(baseUrl2, config2, system, messages2, tools, maxTokens, cb, wd) {
  const onBytes = () => {
    wd.touch();
    cb.onActivity?.();
  };
  const response = await aiFetch(\`\${baseUrl2.replace(/\\/$/, "")}/chat/completions\`, {
    method: "POST",
    signal: wd.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${config2.apiKey}\`,`

// Chromium's net.fetch (the rescue path used when Node's fetch fails at the
// network layer) silently drops a User-Agent header set in fetch headers and
// sends its own UA instead. So we also rewrite the header at the network layer
// via webRequest.onBeforeSendHeaders for AI endpoint requests. Anchor: the
// slides main's AI IPC registration (unique in the v0.6.389 bundle).
const WEBREQ_ANCHOR = `setRescueFetch((url, init) => require$$1$3.net.fetch(url, init));
  require$$1$3.ipcMain.handle(IPC_CHANNELS.aiGetSettings, (event) => {`
const WEBREQ_CODE = `setRescueFetch((url, init) => require$$1$3.net.fetch(url, init));
  try {
    require$$1$3.session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes("/chat/completions")) {
        try {
          const __ua = readJson$1(SETTINGS_PATH(), {}).providers?.custom?.userAgent;
          if (__ua) details.requestHeaders["User-Agent"] = __ua;
        } catch {}
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  } catch (__e) {}
  require$$1$3.ipcMain.handle(IPC_CHANNELS.aiGetSettings, (event) => {`
const WEBREQ_MARKER = `webRequest.onBeforeSendHeaders((details, callback) => {`

// Reasoning echo: thinking-mode providers (DeepSeek, Qwen, Kimi, GLM) require
// the assistant's reasoning_content to be passed back on follow-up requests
// that carry tool calls, or the API rejects the turn with HTTP 400 ("The
// reasoning_content in the thinking mode must be passed back to the API").
// GenOffice's openAiMessages drops it, so we re-inject it from the history
// entries the patched renderers already forward (m.reasoning_content).
// Anchor: the assistant message push inside openAiMessages (unique in the
// v0.6.389 bundle, verified at offset 5422058 in the installed asar).
const REASONING_ANCHOR = `      const hasTools = !!(m.toolCalls && m.toolCalls.length > 0);
      out2.push({
        role: "assistant",
        content: m.text || (hasTools ? null : "(no content)"),`
const REASONING_LINE = `\n        ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),`
const REASONING_MARKER = `...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {})`

// Reasoning pipeline in the MAIN process. The shipped v0.6.389 bundles have NO
// reasoning support at all — no `onReasoning`, no `delta.reasoning_content`
// handling (verified: 0 hits in original, backup, and installed main index.js).
// The renderer hooks wait for a `reasoning` field the stock main never sends,
// so nothing was ever captured. These injections add the missing pipeline:
//   A. accumulate `reasoning_content` deltas in the streaming loop (and call
//      `cb.onReasoning` at stream end; also in the JSON fallback), and
//   B. forward `reasoning` in the done chunk of BOTH ai:stream IPC handlers
//      (docs/slides + sheets) — the patched renderer transport then stores it
//      in history and REASONING_ANCHOR echoes it back on later turns.
const MAIN_REASONING_DECL_ANCHOR = `const pendingTools = /* @__PURE__ */ new Map();
  let stopReason;
  let abnormalFinish;`
const MAIN_REASONING_DECL_CODE = `const pendingTools = /* @__PURE__ */ new Map();
  let stopReason;
  let __goReasoning = "";
  let abnormalFinish;`
const MAIN_REASONING_ACC_ANCHOR = `    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) {`
const MAIN_REASONING_ACC_CODE = `    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.reasoning_content) {
      __goReasoning += choice.delta.reasoning_content;
    }
    if (choice.delta?.content) {`
const MAIN_REASONING_DELIVER_ANCHOR = `  if (!emitted && !sawFinish) {
    throw new Error("The model returned no content (empty stream)");
  }
  if (stopReason) cb.onStopReason?.(stopReason);`
const MAIN_REASONING_DELIVER_CODE = `  if (!emitted && !sawFinish) {
    throw new Error("The model returned no content (empty stream)");
  }
  if (__goReasoning) cb.onReasoning?.(__goReasoning);
  if (stopReason) cb.onStopReason?.(stopReason);`
const MAIN_REASONING_JSON_ANCHOR = `  const choice = msg.choices?.[0];
  let emitted = false;
  if (choice?.message?.content) {`
const MAIN_REASONING_JSON_CODE = `  const choice = msg.choices?.[0];
  let emitted = false;
  if (choice?.message?.reasoning_content) {
    cb.onReasoning?.(choice.message.reasoning_content);
  }
  if (choice?.message?.content) {`
const MAIN_REASONING_DOCS_DECL_ANCHOR = `    const controller = new AbortController();
    activeAiStreams.set(requestId, controller);
    let lastPing = 0;`
const MAIN_REASONING_DOCS_DECL_CODE = `    const controller = new AbortController();
    activeAiStreams.set(requestId, controller);
    let lastPing = 0;
    let __goLastReasoning;`
const MAIN_REASONING_DOCS_WIRE_ANCHOR = `        onStopReason: (reason) => {
          stopReason = reason;
        }
      });
      send({ requestId, type: "done", stopReason });`
const MAIN_REASONING_DOCS_WIRE_CODE = `        onStopReason: (reason) => {
          stopReason = reason;
        },
        onReasoning: (__goR) => {
          __goLastReasoning = __goR;
        }
      });
      send({ requestId, type: "done", stopReason, ...(__goLastReasoning ? { reasoning: __goLastReasoning } : {}) });`
const MAIN_REASONING_SHEETS_DECL_ANCHOR = `    const controller = new AbortController();
    entry.aiStreams.set(requestId, controller);
    let lastPing = 0;`
const MAIN_REASONING_SHEETS_DECL_CODE = `    const controller = new AbortController();
    entry.aiStreams.set(requestId, controller);
    let lastPing = 0;
    let __goLastReasoning;`
const MAIN_REASONING_SHEETS_WIRE_ANCHOR = `        onActivity: ping
      });
      send({ requestId, type: "done" });`
const MAIN_REASONING_SHEETS_WIRE_CODE = `        onActivity: ping,
        onReasoning: (__goR2) => {
          __goLastReasoning = __goR2;
        }
      });
      send({ requestId, type: "done", ...(__goLastReasoning ? { reasoning: __goLastReasoning } : {}) });`
const MAIN_REASONING_MASTER_MARKER = `__goReasoning += choice.delta.reasoning_content`
const MAIN_REASONING_WIRE_MARKER = `onReasoning: (__goR) => {`

// Renderer reasoning capture — the AI-panel bundles live OUTSIDE app.asar at
// resources/modules/<app>/renderer/assets/index-*.js and are WIPED on every
// GenOffice update (the asar patch survives in backups but the modules do not).
// The patched main process already extracts reasoning_content and ships it in
// the done chunk (`reasoning`); the renderers must (1) capture it per turn via
// `onReasoning`, (2) store it on assistant history entries, and (3) forward it
// on follow-up turns so the main-side openAiMessages echo has something to send.
// These injections target the agent-core loop (same code in all five bundles).
const REN_TRANSPORT_MARKER = `chunk.reasoning) cb.onReasoning?.`
const REN_WIRE_MARKER = `onReasoning: (reasoning) => {`

const REN_START_ANCHOR = `  startTurn() {
    const generation = this.generation;
    this.turnText = "";
    this.toolCalls = [];
    this.turnStopReason = null;`
const REN_START_CODE = `  startTurn() {
    const generation = this.generation;
    this.turnText = "";
    this.toolCalls = [];
    this.turnReasoning = "";
    this.turnStopReason = null;`

const REN_WIRE_ANCHOR = `        onStopReason: (reason) => {
          if (generation !== this.generation || settled) return;
          this.turnStopReason = reason;
        },
        onDone: () => {`
const REN_WIRE_CODE = `        onStopReason: (reason) => {
          if (generation !== this.generation || settled) return;
          this.turnStopReason = reason;
        },
        onReasoning: (reasoning) => {
          if (generation !== this.generation || settled) return;
          this.turnReasoning += reasoning;
        },
        onDone: () => {`

const REN_TRANSPORT_ANCHOR = `          if (chunk.stopReason) cb.onStopReason?.(chunk.stopReason);
          cb.onDone();`
const REN_TRANSPORT_CODE = `          if (chunk.stopReason) cb.onStopReason?.(chunk.stopReason);
          if (chunk.reasoning) cb.onReasoning?.(chunk.reasoning);
          cb.onDone();`

const REN_PUSH_TOOL_ANCHOR = `    this.history.push({
      role: "assistant",
      text: this.turnText,
      toolCalls: toolCalls.map(({ id, name, input }) => ({ id, name, input }))
    });`
const REN_PUSH_TOOL_CODE = `    this.history.push({
      role: "assistant",
      text: this.turnText,
      toolCalls: toolCalls.map(({ id, name, input }) => ({ id, name, input })),
      ...this.turnReasoning ? { reasoning_content: this.turnReasoning } : {}
    });`

// Older builds used the shorthand `toolCalls` (the array is already normalized).
const REN_PUSH_TOOL2_ANCHOR = `    this.history.push({
      role: "assistant",
      text: this.turnText,
      toolCalls
    });`
const REN_PUSH_TOOL2_CODE = `    this.history.push({
      role: "assistant",
      text: this.turnText,
      toolCalls,
      ...this.turnReasoning ? { reasoning_content: this.turnReasoning } : {}
    });`

// The sheets bundle renames `name` to `name2` in its destructuring.
const REN_PUSH_TOOL3_ANCHOR = `    this.history.push({
      role: "assistant",
      text: this.turnText,
      toolCalls: toolCalls.map(({ id, name: name2, input }) => ({ id, name: name2, input }))
    });`
const REN_PUSH_TOOL3_CODE = `    this.history.push({
      role: "assistant",
      text: this.turnText,
      toolCalls: toolCalls.map(({ id, name: name2, input }) => ({ id, name: name2, input })),
      ...this.turnReasoning ? { reasoning_content: this.turnReasoning } : {}
    });`

const REN_PUSH_TERMINAL_ANCHOR = `    this.history.push({ role: "assistant", text: this.turnText || COMPLETED_VIA_TOOLS_TEXT });`
const REN_PUSH_TERMINAL_CODE = `    this.history.push({ role: "assistant", text: this.turnText || COMPLETED_VIA_TOOLS_TEXT, ...this.turnReasoning ? { reasoning_content: this.turnReasoning } : {} });`

const REN_PUSH_VALIDATE_ANCHOR = `    this.history.push({ role: "assistant", text: this.turnText });`
const REN_PUSH_VALIDATE_CODE = `    this.history.push({ role: "assistant", text: this.turnText, ...this.turnReasoning ? { reasoning_content: this.turnReasoning } : {} });`

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(msg = '') {
  console.log(msg)
}

function warn(msg) {
  console.warn(`[warn] ${msg}`)
}

function fail(msg, code = 1) {
  console.error(`[error] ${msg}`)
  process.exit(code)
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close()
      resolve(/^y(es)?$/i.test(ans.trim()))
    })
  })
}

// ---------------------------------------------------------------------------
// asar reader/writer (self-contained).
// Archive layout:
//   [0..4)  u32 = 4                    (size-pickle payload size)
//   [4..8)  u32 = headerBuf.length     (size-pickle value)
//   [8..)   headerBuf (a string pickle):
//       [0..4)  u32 = 4 + align4(len)  (header pickle payload size)
//       [4..8)  u32 = len              (header JSON string length)
//       [8..8+len)  header JSON string
//       padding zeros to 4-byte alignment
//   then file contents at offset 8 + headerBuf.length.
export function readAsarHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    fs.readSync(fd, sizeBuf, 0, 8, 0)
    const headerSize = sizeBuf.readUInt32LE(4) // headerBuf length
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 8)
    const headerStringSize = headerBuf.readUInt32LE(4) // JSON string length
    const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + headerStringSize))
    return { header, contentOffset: 8 + headerSize }
  } finally {
    fs.closeSync(fd)
  }
}

export function extractAsar(archivePath, destDir) {
  const { header, contentOffset } = readAsarHeader(archivePath)
  const fd = fs.openSync(archivePath, 'r')
  try {
    const walk = (node, rel) => {
      if (node.files) {
        fs.mkdirSync(path.join(destDir, rel), { recursive: true })
        for (const [name, child] of Object.entries(node.files)) {
          walk(child, rel ? `${rel}/${name}` : name)
        }
      } else if (node.link !== undefined) {
        fs.symlinkSync(node.link, path.join(destDir, rel))
      } else {
        const buf = Buffer.alloc(node.size)
        fs.readSync(fd, buf, 0, node.size, contentOffset + parseInt(node.offset, 10))
        fs.writeFileSync(path.join(destDir, rel), buf)
      }
    }
    // header.files is a plain object of top-level entries (not wrapped in {files})
    for (const [name, child] of Object.entries(header.files)) {
      walk(child, name)
    }
  } finally {
    fs.closeSync(fd)
  }
}

export function packAsar(srcDir, archivePath) {
  const entries = [] // { rel, size } | { rel, link }
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relPath)
      else if (entry.isSymbolicLink()) entries.push({ rel: relPath, link: fs.readlinkSync(full) })
      else if (entry.isFile()) entries.push({ rel: relPath, size: fs.statSync(full).size })
    }
  }
  walk(srcDir, '')

  const root = { files: {} }
  let offset = 0
  for (const e of entries) {
    const parts = e.rel.split('/')
    let node = root.files
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = { files: {} }
      node = node[parts[i]].files
    }
    const name = parts[parts.length - 1]
    if (e.link !== undefined) {
      node[name] = { link: e.link }
    } else {
      node[name] = { size: e.size, offset: String(offset) }
      offset += e.size
    }
  }

  const headerStr = JSON.stringify(root)
  const len = Buffer.byteLength(headerStr, 'utf8')
  const alignedLen = len + ((4 - (len % 4)) % 4)
  const headerBuf = Buffer.alloc(8 + alignedLen)
  headerBuf.writeUInt32LE(4 + alignedLen, 0) // header pickle payload size
  headerBuf.writeUInt32LE(len, 4) // header JSON string length
  headerBuf.write(headerStr, 8, 'utf8') // padding after the string stays zero

  const sizeBuf = Buffer.alloc(8)
  sizeBuf.writeUInt32LE(4, 0) // size-pickle payload size
  sizeBuf.writeUInt32LE(headerBuf.length, 4) // headerBuf length

  const out = fs.openSync(archivePath, 'w')
  try {
    fs.writeSync(out, sizeBuf)
    fs.writeSync(out, headerBuf)
    for (const e of entries) {
      if (e.link !== undefined) continue
      fs.writeSync(out, fs.readFileSync(path.join(srcDir, e.rel)))
    }
  } finally {
    fs.closeSync(out)
  }
}

// Read a single file out of an asar without extracting everything.
export function readFileFromAsar(archivePath, filePath) {
  const { header, contentOffset } = readAsarHeader(archivePath)
  let node = header.files
  for (const part of filePath.split('/')) {
    node = node && node[part]
    if (!node) return null
    if (node.files) node = node.files // descend into directory nodes
  }
  if (!node || typeof node.size !== 'number') return null // not a file
  const fd = fs.openSync(archivePath, 'r')
  try {
    const buf = Buffer.alloc(node.size)
    fs.readSync(fd, buf, 0, node.size, contentOffset + parseInt(node.offset, 10))
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function detectInstall() {
  const home = os.homedir()
  const candidates = []
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    candidates.push(path.join(local, 'Programs', 'GenOffice'))
    candidates.push(path.join(local, 'GenOffice'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/GenOffice.app/Contents/Resources')
    candidates.push(path.join(home, 'Applications', 'GenOffice.app', 'Contents', 'Resources'))
  } else {
    candidates.push(
      '/opt/GenOffice',
      '/usr/lib/genoffice',
      '/usr/lib/GenOffice',
      path.join(home, '.local', 'share', 'GenOffice'),
      path.join(home, '.local', 'lib', 'GenOffice'),
      '/snap/genoffice/current'
    )
  }
  for (const c of candidates) {
    const found = resolveInstall(c)
    if (found) return found
  }
  return null
}

// Resolve the resources dir + app.asar from an install dir. The install dir may
// be the app root (containing resources/app.asar, Windows/Linux) or the
// resources dir itself (macOS: GenOffice.app/Contents/Resources/app.asar).
function resolveInstall(installDir) {
  for (const sub of ['', 'resources']) {
    const asar = path.join(installDir, sub, 'app.asar')
    if (fs.existsSync(asar)) return { resourcesDir: path.dirname(asar), asar }
  }
  return null
}

function detectUserDataDir() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return process.env.APPDATA
      ? path.join(process.env.APPDATA, 'GenOffice')
      : path.join(home, 'AppData', 'Roaming', 'GenOffice')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'GenOffice')
  }
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'GenOffice')
    : path.join(home, '.config', 'GenOffice')
}

function isGenOfficeRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq GenOffice.exe', '/NH'], { encoding: 'utf8' })
      return /GenOffice\.exe/i.test(out)
    }
    // [/] trick: the pattern matches a literal '/GenOffice' in other processes'
    // command lines but not this pgrep invocation itself.
    const out = execFileSync('pgrep', ['-f', '[/]GenOffice'], { encoding: 'utf8' })
    return out.trim().length > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Patch state
// ---------------------------------------------------------------------------

function isPatched(asarPath) {
  const buf = readFileFromAsar(asarPath, MAIN_JS)
  if (!buf) return null // cannot determine (different layout)
  return !buf.includes(NEEDLE)
}

function isUaInjected(asarPath) {
  const buf = readFileFromAsar(asarPath, MAIN_JS)
  if (!buf) return false
  return buf.includes(UA_ANCHOR + UA_LINE) && buf.includes(UA_ANCHOR_STREAM + UA_LINE)
}

function isWebReqInjected(asarPath) {
  const buf = readFileFromAsar(asarPath, MAIN_JS)
  if (!buf) return false
  return buf.includes(WEBREQ_MARKER)
}

function isReasoningInjected(asarPath) {
  const buf = readFileFromAsar(asarPath, MAIN_JS)
  if (!buf) return false
  return (
    buf.includes(REASONING_MARKER) &&
    buf.includes(MAIN_REASONING_MASTER_MARKER) &&
    buf.includes(MAIN_REASONING_WIRE_MARKER)
  )
}

// -- Renderer modules (outside the asar; wiped on GenOffice updates) ---------

export function rendererBundles(resourcesDir) {
  const dir = path.join(resourcesDir, 'modules')
  const found = []
  if (!fs.existsSync(dir)) return found
  for (const app of fs.readdirSync(dir)) {
    const assetDir = path.join(dir, app, 'renderer', 'assets')
    if (!fs.existsSync(assetDir)) continue
    for (const f of fs.readdirSync(assetDir)) {
      if (/^index-.+\.js$/.test(f)) found.push({ app, name: f, file: path.join(assetDir, f) })
    }
  }
  return found.sort((a, b) => a.app.localeCompare(b.app))
}

export function rendererBundlePatched(file) {
  if (!fs.existsSync(file)) return null
  const c = fs.readFileSync(file, 'utf8')
  return c.includes(REN_TRANSPORT_MARKER) && c.includes(REN_WIRE_MARKER)
}

// true = all found modules patched, false = at least one unpatched, null = none found
function renderersPatched(resourcesDir) {
  const bundles = rendererBundles(resourcesDir)
  if (!bundles.length) return null
  return bundles.every((b) => rendererBundlePatched(b.file))
}

export function patchRendererBundle(filePath) {
  if (rendererBundlePatched(filePath)) return { changed: false, applied: 0, missing: [], alreadyPatched: true }
  const content = fs.readFileSync(filePath, 'utf8')
  let out = content
  const steps = [
    [REN_START_ANCHOR, REN_START_CODE, 'startTurn reset'],
    [REN_WIRE_ANCHOR, REN_WIRE_CODE, 'loop onReasoning'],
    [REN_TRANSPORT_ANCHOR, REN_TRANSPORT_CODE, 'transport done'],
    [REN_PUSH_TOOL_ANCHOR, REN_PUSH_TOOL_CODE, null],
    [REN_PUSH_TOOL2_ANCHOR, REN_PUSH_TOOL2_CODE, null], // shorthand fallback
    [REN_PUSH_TOOL3_ANCHOR, REN_PUSH_TOOL3_CODE, null], // sheets (name2) form
    [REN_PUSH_TERMINAL_ANCHOR, REN_PUSH_TERMINAL_CODE, 'history push (terminal)'],
    [REN_PUSH_VALIDATE_ANCHOR, REN_PUSH_VALIDATE_CODE, null], // newer builds only
  ]
  let applied = 0
  const missing = []
  for (const [anchor, code, label] of steps) {
    if (out.includes(anchor) && !out.includes(code)) {
      out = out.split(anchor).join(code)
      applied++
    } else if (label && !out.includes(anchor)) {
      missing.push(label)
    }
  }
  const toolCovered =
    out.includes(REN_PUSH_TOOL_CODE) || out.includes(REN_PUSH_TOOL2_CODE) || out.includes(REN_PUSH_TOOL3_CODE)
  if (!toolCovered) missing.push('history push (tool turn)')
  if (!out.includes(REN_PUSH_TERMINAL_CODE)) missing.push('history push (terminal)')
  if (missing.length) {
    warn(`Renderer ${path.basename(filePath)}: anchor not found (${missing.join(', ')}); reasoning capture may be incomplete.`)
  }
  if (out !== content) {
    // The renderer bundles are ESM (top-level exports/await), so validate with
    // `node --check` against a temp .mjs rather than `new Function`.
    const tmp = path.join(os.tmpdir(), `go-renderer-check-${process.pid}.mjs`)
    try {
      fs.writeFileSync(tmp, out)
      try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
      } catch (err) {
        fail(`Patched renderer ${path.basename(filePath)} failed syntax check: ${err.stderr?.toString() || err.message}`)
      }
    } finally {
      fs.rmSync(tmp, { force: true })
    }
    fs.writeFileSync(filePath, out)
  }
  return { changed: out !== content, applied, missing }
}

function backupRenderers(backupDir, resourcesDir, ts) {
  const saved = []
  for (const b of rendererBundles(resourcesDir)) {
    const dest = path.join(backupDir, `${b.name}.bak-${ts}`)
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(b.file, dest)
      saved.push({ app: b.app, file: b.name, backup: `${b.name}.bak-${ts}` })
    }
  }
  return saved
}

function patchAllRenderers(resourcesDir) {
  const bundles = rendererBundles(resourcesDir)
  const results = []
  for (const b of bundles) {
    if (rendererBundlePatched(b.file)) {
      results.push({ app: b.app, name: b.name, changed: false })
    } else {
      const r = patchRendererBundle(b.file)
      results.push({ app: b.app, name: b.name, changed: r.changed, applied: r.applied })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Backup / manifest
// ---------------------------------------------------------------------------

function backupDirFor(resourcesDir, override) {
  return override || path.join(resourcesDir, 'backups')
}

function manifestPath(backupDir) {
  return path.join(backupDir, 'manifest.json')
}

function readManifest(backupDir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(backupDir), 'utf8'))
  } catch {
    return { patches: [] }
  }
}

function writeManifest(backupDir, manifest) {
  fs.writeFileSync(manifestPath(backupDir), JSON.stringify(manifest, null, 2) + '\n')
}

function latestBackup(backupDir, prefix) {
  if (!fs.existsSync(backupDir)) return null
  const files = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith(prefix))
    .sort()
  return files.length ? path.join(backupDir, files[files.length - 1]) : null
}

// ---------------------------------------------------------------------------
// Patch logic
// ---------------------------------------------------------------------------

function patchMainJs(mainJsPath) {
  const content = fs.readFileSync(mainJsPath, 'utf8')
  let out = content
  const count = out.split(NEEDLE).length - 1
  if (count > 0) out = out.split(NEEDLE).join('')

  // Inject the config-driven User-Agent hook (idempotent) into both request
  // paths: the non-streaming chat call and the streaming turn (the AI panel
  // uses the streaming one).
  let uaInjected = 0
  for (const anchor of [UA_ANCHOR, UA_ANCHOR_STREAM]) {
    if (out.includes(anchor) && !out.includes(anchor + UA_LINE)) {
      out = out.split(anchor).join(anchor + UA_LINE)
      uaInjected++
    } else if (!out.includes(anchor)) {
      warn(`Could not find a custom provider headers block in ${MAIN_JS}; --ua will be limited.`)
    }
  }

  // Inject a webRequest User-Agent rewrite (idempotent) so the header also
  // reaches the endpoint when the request goes through Chromium's net.fetch.
  let webReqInjected = false
  if (!out.includes(WEBREQ_MARKER)) {
    if (!out.includes(WEBREQ_ANCHOR)) {
      warn(`Could not find the AI IPC registration in ${MAIN_JS}; --ua will not cover the Chromium fetch path.`)
    } else {
      out = out.split(WEBREQ_ANCHOR).join(WEBREQ_CODE)
      webReqInjected = true
    }
  }

  // Inject reasoning_content passthrough in openAiMessages (idempotent) so
  // thinking-mode providers receive the prior assistant reasoning on every
  // tool-carrying follow-up request.
  let reasoningInjected = false
  if (!out.includes(REASONING_MARKER)) {
    if (!out.includes(REASONING_ANCHOR)) {
      warn(`Could not find the openAiMessages assistant push in ${MAIN_JS}; reasoning_content will be dropped (deepseek/qwen/kimi/glm thinking mode will fail).`)
    } else {
      out = out.split(REASONING_ANCHOR).join(REASONING_ANCHOR + REASONING_LINE)
      reasoningInjected = true
    }
  }

  // Inject the reasoning capture pipeline (idempotent, marker-guarded): the
  // shipped bundle never extracts reasoning_content, so we add accumulation
  // in the streaming loop, delivery via cb.onReasoning at stream end (plus
  // the JSON fallback), and forwarding in both ai:stream done chunks.
  let reasoningPipeline = 0
  const reasoningSteps = [
    [MAIN_REASONING_DECL_ANCHOR, MAIN_REASONING_DECL_CODE],
    [MAIN_REASONING_ACC_ANCHOR, MAIN_REASONING_ACC_CODE],
    [MAIN_REASONING_DELIVER_ANCHOR, MAIN_REASONING_DELIVER_CODE],
    [MAIN_REASONING_JSON_ANCHOR, MAIN_REASONING_JSON_CODE],
    [MAIN_REASONING_DOCS_DECL_ANCHOR, MAIN_REASONING_DOCS_DECL_CODE],
    [MAIN_REASONING_DOCS_WIRE_ANCHOR, MAIN_REASONING_DOCS_WIRE_CODE],
    [MAIN_REASONING_SHEETS_DECL_ANCHOR, MAIN_REASONING_SHEETS_DECL_CODE],
    [MAIN_REASONING_SHEETS_WIRE_ANCHOR, MAIN_REASONING_SHEETS_WIRE_CODE],
  ]
  for (const [anchor, code] of reasoningSteps) {
    if (out.includes(anchor) && !out.includes(code)) {
      out = out.split(anchor).join(code)
      reasoningPipeline++
    } else if (!out.includes(anchor)) {
      warn(`Reasoning pipeline: anchor not found (${anchor.split('\n')[0].slice(0, 60)}...) — capture will be incomplete.`)
    }
  }

  if (count === 0 && uaInjected === 0 && !webReqInjected && !reasoningInjected && reasoningPipeline === 0) {
    return { changed: false, count: 0, uaInjected: 0, webReqInjected: false, reasoningInjected: false }
  }
  // Syntax sanity check before writing anything.
  try {
    new Function(out) // eslint-disable-line no-new-func
  } catch (err) {
    fail(`Patched ${MAIN_JS} failed syntax check: ${err.message}`)
  }
  fs.writeFileSync(mainJsPath, out)
  return { changed: true, count, uaInjected, webReqInjected, reasoningInjected: reasoningInjected || reasoningPipeline > 0 }
}

function writeAiSettings(userDataDir, { apiKey, model, baseUrl, userAgent }) {
  const settingsPath = path.join(userDataDir, AI_SETTINGS_FILE)
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    settings = {}
  }
  settings.provider = 'custom'
  settings.providers = settings.providers || {}
  settings.providers.custom = {
    apiKey,
    model,
    baseUrl: baseUrl.replace(/\/+$/, ''),
  }
  // --ua sets the User-Agent; omit it to use the default.
  settings.providers.custom.userAgent = userAgent !== undefined ? userAgent : DEFAULT_UA
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return settingsPath
}

function backupExisting(backupDir, resourcesDir, userDataDir, ts) {
  fs.mkdirSync(backupDir, { recursive: true })
  const asarBackup = path.join(backupDir, `app.asar.bak-${ts}`)
  fs.copyFileSync(path.join(resourcesDir, 'app.asar'), asarBackup)

  let aiSettingsBackup = null
  let aiSettingsExisted = false
  const aiPath = path.join(userDataDir, AI_SETTINGS_FILE)
  if (fs.existsSync(aiPath)) {
    aiSettingsExisted = true
    aiSettingsBackup = path.join(backupDir, `${AI_SETTINGS_FILE}.bak-${ts}`)
    fs.copyFileSync(aiPath, aiSettingsBackup)
  }
  return { asarBackup, aiSettingsBackup, aiSettingsExisted }
}

async function cmdPatch(opts) {
  const install = opts.installDir ? resolveInstall(opts.installDir) : detectInstall()

  if (!install || !fs.existsSync(install.asar)) {
    fail(
      'Could not find GenOffice app.asar. Pass --install-dir <dir> (the folder containing resources/app.asar).'
    )
  }
  const resourcesDir = install.resourcesDir
  const asarPath = install.asar
  const userDataDir = opts.userDataDir || detectUserDataDir()
  const backupDir = backupDirFor(resourcesDir, opts.backupDir)

  if (!opts.apiKey) {
    // Reuse the key already stored in ai-settings.json so a plain
    // `node patch-genoffice.mjs patch` re-patches after an app update.
    let existing = null
    try {
      existing = JSON.parse(fs.readFileSync(path.join(userDataDir, AI_SETTINGS_FILE), 'utf8'))
    } catch {}
    if (existing?.providers?.custom?.apiKey) {
      opts.apiKey = existing.providers.custom.apiKey
      log('Reusing the API key already stored in ai-settings.json.')
    } else {
      fail('--api-key <key> is required for patch (your OpenCode API key — Zen or Go).')
    }
  }

  // Preserve the model/baseUrl already configured when not passed explicitly,
  // so a plain re-patch does not reset them to the provider defaults.
  if (!opts.modelExplicit || !opts.baseUrlExplicit) {
    let existing = null
    try {
      existing = JSON.parse(fs.readFileSync(path.join(userDataDir, AI_SETTINGS_FILE), 'utf8'))
    } catch {}
    const c = existing?.providers?.custom
    if (c) {
      if (!opts.modelExplicit && c.model) opts.model = c.model
      if (!opts.baseUrlExplicit && c.baseUrl) opts.baseUrl = c.baseUrl
    }
  }

  log('GenOffice patch plan')
  log(`  install dir : ${resourcesDir}`)
  log(`  app.asar    : ${asarPath} (${fs.statSync(asarPath).size} bytes)`)
  log(`  user data   : ${userDataDir}`)
  log(`  backup dir  : ${backupDir}`)
  log(`  provider    : ${PROVIDERS[opts.provider].label} (${opts.provider})`)
  log(`  endpoint    : ${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`)
  log(`  model       : ${opts.model}`)

  const forcePatched = isPatched(asarPath)
  const uaInjected = isUaInjected(asarPath)
  const webReqInjected = isWebReqInjected(asarPath)
  const reasoningInjected = isReasoningInjected(asarPath)
  const rendererState = renderersPatched(resourcesDir)
  log(`  renderers   : ${rendererState === true ? 'reasoning capture patched' : rendererState === false ? 'UNPATCHED (app updated? re-run to restore)' : 'not found'}`)
  // Fully patched = force-reset removed AND both User-Agent mechanisms present
  // (header hook for Node fetch + webRequest rewrite for Chromium net.fetch)
  // AND the reasoning_content echo in openAiMessages. Then skip all asar work
  // (backup/extract/repack) so the existing backup stays the restore point,
  // and only update settings.
  const skipAsar = forcePatched === true && uaInjected && webReqInjected && reasoningInjected
  if (skipAsar) {
    warn('app.asar already appears patched; only ai-settings.json will be updated.')
  } else if (forcePatched === true && (!uaInjected || !webReqInjected || !reasoningInjected)) {
    const missing = []
    if (!uaInjected) missing.push('User-Agent hook')
    if (!webReqInjected) missing.push('webRequest rewrite')
    if (!reasoningInjected) missing.push('reasoning pipeline')
    warn(`app.asar is patched but missing ${missing.join(', ')}; re-patching to add it (no new backup).`)
  } else if (forcePatched === null) {
    warn(`Could not read ${MAIN_JS} from app.asar; this may be an unsupported GenOffice version.`)
  }

  if (isGenOfficeRunning()) {
    fail('GenOffice appears to be running. Close it first, then re-run.')
  }

  if (!opts.yes) {
    const ok = await confirm('Apply this patch now?')
    if (!ok) {
      log('Aborted.')
      process.exit(0)
    }
  }

  const ts = timestamp()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genoffice-patch-'))
  const newAsar = path.join(resourcesDir, 'app.asar.new')
  let b = null
  let rendererBaks = []

  try {
    // 1. Auto backup — only when the force-reset patch has NOT been applied,
    //    so the original backup remains the restore point. Renderer bundles are
    //    backed up whenever they are currently unpatched (before we patch them).
    if (forcePatched === true) {
      log('app.asar already patched — keeping the existing backup as the restore point.')
    } else if (!opts.dryRun) {
      b = backupExisting(backupDir, resourcesDir, userDataDir, ts)
      log(`Backed up app.asar -> ${b.asarBackup}`)
      if (b.aiSettingsBackup) log(`Backed up ${AI_SETTINGS_FILE} -> ${b.aiSettingsBackup}`)
    } else {
      log(`[dry-run] would back up app.asar to ${backupDir}/app.asar.bak-${ts}`)
    }

    if (rendererState === false) {
      if (!opts.dryRun) {
        rendererBaks = backupRenderers(backupDir, resourcesDir, ts)
        if (rendererBaks.length) log(`Backed up ${rendererBaks.length} renderer bundle(s) to ${backupDir}`)
      } else {
        log(`[dry-run] would back up ${rendererBundles(resourcesDir).length} renderer bundle(s) to ${backupDir}`)
      }
    }

    if (!skipAsar) {
      // 2. Extract
      if (!opts.dryRun) {
        log('Extracting app.asar ...')
        extractAsar(asarPath, tmpDir)
      }

      // 3. Patch main JS
      const mainJsPath = path.join(tmpDir, MAIN_JS)
      if (!opts.dryRun && !fs.existsSync(mainJsPath)) {
        fail(`${MAIN_JS} not found inside app.asar; unsupported version.`)
      }
      const result = opts.dryRun
        ? {
            changed: forcePatched !== true || !uaInjected || !webReqInjected || !reasoningInjected,
            count: forcePatched === true ? 0 : 2,
            uaInjected: uaInjected ? 0 : 2,
            webReqInjected: !webReqInjected,
            reasoningInjected: !reasoningInjected,
          }
        : patchMainJs(mainJsPath)
      if (result.changed) {
        if (result.count > 0) log(`Removed ${result.count} occurrence(s) of ${NEEDLE}`)
        if (result.uaInjected > 0) log(`Injected User-Agent hook into ${result.uaInjected} request path(s).`)
        if (result.webReqInjected) log('Injected webRequest User-Agent rewrite (Chromium fetch path).')
        if (result.reasoningInjected) log('Injected reasoning pipeline (main capture + openAiMessages echo).')
      } else {
        warn('No patchable content found in main JS; continuing with settings write.')
      }

      // 4. Repack + install
      if (!opts.dryRun) {
        log('Repacking app.asar ...')
        packAsar(tmpDir, newAsar)
        log(`Repacked -> ${newAsar} (${fs.statSync(newAsar).size} bytes)`)
        fs.copyFileSync(newAsar, asarPath)
        fs.rmSync(newAsar, { force: true })
        log(`Installed patched app.asar -> ${asarPath}`)
      } else {
        log(`[dry-run] would repack and replace ${asarPath}`)
      }
    } else if (!opts.dryRun) {
      log('Skipping asar extract/patch/repack (nothing to change).')
    }

    // 5. Patch renderer bundles (reasoning capture) so the AI-panel history
    //    includes reasoning_content. Independent of the asar workflow.
    if (rendererState === false) {
      if (!opts.dryRun) {
        const results = patchAllRenderers(resourcesDir)
        const changed = results.filter((r) => r.changed)
        changed.forEach((r) => log(`Patched ${r.app}/renderer ${r.name}`))
        if (!changed.length) warn('Renderer bundles looked unpatched but nothing changed — anchors may have drifted.')
      } else {
        log(`[dry-run] would patch ${rendererBundles(resourcesDir).length} renderer bundle(s) (reasoning capture).`)
      }
    } else {
      log('Renderer bundles already patched (reasoning capture).')
    }

    // 6. Write ai-settings.json (always — this is how model/base-url/api-key update)
    if (!opts.dryRun) {
      const settingsPath = writeAiSettings(userDataDir, {
        apiKey: opts.apiKey,
        model: opts.model,
        baseUrl: opts.baseUrl,
        userAgent: opts.userAgent,
      })
      log(`Wrote ${settingsPath}`)
    } else {
      log(`[dry-run] would write ${path.join(userDataDir, AI_SETTINGS_FILE)}`)
    }

    // 7. Manifest
    if (!opts.dryRun) {
      const manifest = readManifest(backupDir)
      const entry = {
        timestamp: ts,
        asarBackup: b ? `app.asar.bak-${ts}` : null,
        asarSha256: b ? sha256(b.asarBackup) : null,
        aiSettingsBackup: b && b.aiSettingsBackup ? `ai-settings.json.bak-${ts}` : null,
        aiSettingsExisted: b ? b.aiSettingsExisted : false,
        rendererBackups: rendererBaks.length ? rendererBaks.map((r) => ({ app: r.app, file: r.file, backup: r.backup })) : undefined,
        provider: opts.provider,
        baseUrl: opts.baseUrl,
        model: opts.model,
        userAgent: opts.userAgent ?? DEFAULT_UA,
      }
      manifest.patches.push(entry)
      writeManifest(backupDir, manifest)
    }

    log('')
    log('Done. Restart GenOffice and use the AI panel.')
    log(`To undo: node patch-genoffice.mjs restore`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Restore logic
// ---------------------------------------------------------------------------

async function cmdRestore(opts) {
  const install = opts.installDir ? resolveInstall(opts.installDir) : detectInstall()

  if (!install || !fs.existsSync(install.asar)) {
    fail('Could not find GenOffice app.asar. Pass --install-dir <dir>.')
  }
  const resourcesDir = install.resourcesDir
  const asarPath = install.asar
  const userDataDir = opts.userDataDir || detectUserDataDir()
  const backupDir = backupDirFor(resourcesDir, opts.backupDir)

  const asarBackup = latestBackup(backupDir, 'app.asar.bak-')
  if (!asarBackup) {
    fail(`No app.asar backup found in ${backupDir}. Nothing to restore.`)
  }

  log(`Restore plan`)
  log(`  backup      : ${asarBackup}`)
  log(`  restore to  : ${asarPath}`)

  if (isGenOfficeRunning()) {
    fail('GenOffice appears to be running. Close it first, then re-run.')
  }

  if (!opts.yes) {
    const ok = await confirm('Restore the original app.asar from this backup?')
    if (!ok) {
      log('Aborted.')
      process.exit(0)
    }
  }

  if (opts.dryRun) {
    log(`[dry-run] would copy ${asarBackup} -> ${asarPath}`)
    return
  }

  fs.copyFileSync(asarBackup, asarPath)
  log(`Restored ${asarPath}`)

  // Restore ai-settings.json if a backup exists, otherwise remove the patched one.
  const aiPath = path.join(userDataDir, AI_SETTINGS_FILE)
  const aiBackup = latestBackup(backupDir, `${AI_SETTINGS_FILE}.bak-`)
  if (aiBackup) {
    fs.copyFileSync(aiBackup, aiPath)
    log(`Restored ${aiPath} from ${aiBackup}`)
  } else if (fs.existsSync(aiPath)) {
    fs.rmSync(aiPath, { force: true })
    log(`Removed patched ${aiPath} (no pre-patch backup existed)`)
  }

  // Restore renderer bundles (original pre-patch copies, newest per name).
  if (fs.existsSync(backupDir)) {
    const baks = fs.readdirSync(backupDir).filter((f) => /^index-.+\.js\.bak-\d{8}-\d{6}$/.test(f)).sort()
    const byName = new Map()
    for (const f of baks) {
      const orig = f.replace(/\.bak-\d{8}-\d{6}$/, '')
      byName.set(orig, path.join(backupDir, f))
    }
    let restored = 0
    for (const b of rendererBundles(resourcesDir)) {
      const src = byName.get(b.name)
      if (src) {
        fs.copyFileSync(src, b.file)
        log(`Restored renderer ${b.app}/${b.name} from ${src}`)
        restored++
      }
    }
    if (restored) log(`Removed reasoning capture from ${restored} renderer bundle(s).`)
  }

  log('Done. GenOffice is back to its original state.')
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function cmdStatus(opts) {
  const install = opts.installDir ? resolveInstall(opts.installDir) : detectInstall()

  if (!install || !fs.existsSync(install.asar)) {
    log('GenOffice install: NOT FOUND (use --install-dir to point at it)')
  } else {
    const resourcesDir = install.resourcesDir
    const asarPath = install.asar
    const userDataDir = opts.userDataDir || detectUserDataDir()
    const backupDir = backupDirFor(resourcesDir, opts.backupDir)
    const state = isPatched(asarPath)
    const uaInjected = isUaInjected(asarPath)
    const webReqInjected = isWebReqInjected(asarPath)
    const reasoningInjected = isReasoningInjected(asarPath)
    const rendererState = renderersPatched(resourcesDir)

    log(`GenOffice install : ${resourcesDir}`)
    log(`app.asar          : ${asarPath} (${fs.statSync(asarPath).size} bytes)`)
    log(`patch state       : ${state === true ? 'PATCHED' : state === false ? 'ORIGINAL' : 'UNKNOWN'}`)
    log(`user-agent hook   : ${uaInjected ? 'present' : 'absent'}`)
    log(`ua webRequest     : ${webReqInjected ? 'present' : 'absent'}`)
    log(`reasoning pipeline : ${reasoningInjected ? 'present' : 'absent'}`)
    log(`renderer capture  : ${rendererState === true ? 'PATCHED' : rendererState === false ? 'UNPATCHED (run patch again)' : 'not found'}`)
    log(`user data         : ${userDataDir}`)
    log(`ai-settings.json  : ${fs.existsSync(path.join(userDataDir, AI_SETTINGS_FILE)) ? 'present' : 'absent'}`)
    log(`backup dir        : ${backupDir}`)

    const backups = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((f) => f.startsWith('app.asar.bak-')).sort()
      : []
    log(`backups           : ${backups.length ? backups.join(', ') : 'none'}`)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  log(`Usage: node patch-genoffice.mjs <command> [options]

Commands:
  patch    Apply the patch (default). Automatically backs up app.asar first.
  restore  Restore the original app.asar from the latest backup.
  status   Show install location, patch state, and available backups.

Options:
  --provider <p>      Endpoint provider: zen | go (default: ${DEFAULT_PROVIDER})
  --api-key <key>     OpenCode API key, Zen or Go (required for patch)
  --model <model>     Model id (default: ${PROVIDERS[DEFAULT_PROVIDER].model} for ${DEFAULT_PROVIDER})
  --base-url <url>    Base URL, no trailing slash (default: ${PROVIDERS[DEFAULT_PROVIDER].baseUrl})
  --ua <ua>           User-Agent header sent to the AI endpoint (default: ${DEFAULT_UA})
  --install-dir <d>   GenOffice install dir (auto-detected if omitted)
  --user-data <d>     GenOffice user-data dir (auto-detected if omitted)
  --backup-dir <d>    Backup dir (default: <install>/resources/backups)
  --dry-run           Show what would be done without changing anything
  --yes, -y           Skip confirmation prompts
  --help, -h          Show this help

Notes:
  patch also patches the AI-panel renderer bundles under resources/modules
  (reasoning capture), which GenOffice updates wipe every release. Re-run
  'node patch-genoffice.mjs patch' after an app update. Omit --api-key to reuse
  the key already stored in ai-settings.json.

Examples:
  node patch-genoffice.mjs patch --api-key sk-xxxx
  node patch-genoffice.mjs patch --api-key sk-xxxx --provider go
  node patch-genoffice.mjs patch --api-key sk-xxxx --model deepseek-v4-flash-free
  node patch-genoffice.mjs restore
  node patch-genoffice.mjs status`)
}

function parseArgs(argv) {
  const opts = {
    command: 'patch',
    apiKey: null,
    provider: DEFAULT_PROVIDER,
    model: null,
    baseUrl: null,
    userAgent: undefined,
    installDir: null,
    userDataDir: null,
    backupDir: null,
    dryRun: false,
    yes: false,
    help: false,
    modelExplicit: false,
    baseUrlExplicit: false,
  }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === 'patch' || a === 'restore' || a === 'status') {
      opts.command = a
    } else if (a === '--restore') {
      opts.command = 'restore'
    } else if (a === '--provider') {
      opts.provider = args[++i]
    } else if (a === '--api-key') {
      opts.apiKey = args[++i]
    } else if (a === '--model') {
      opts.model = args[++i]
      opts.modelExplicit = true
    } else if (a === '--base-url') {
      opts.baseUrl = args[++i]
      opts.baseUrlExplicit = true
    } else if (a === '--ua') {
      opts.userAgent = args[++i]
    } else if (a === '--install-dir') {
      opts.installDir = args[++i]
    } else if (a === '--user-data') {
      opts.userDataDir = args[++i]
    } else if (a === '--backup-dir') {
      opts.backupDir = args[++i]
    } else if (a === '--dry-run') {
      opts.dryRun = true
    } else if (a === '--yes' || a === '-y') {
      opts.yes = true
    } else if (a === '--help' || a === '-h') {
      opts.help = true
    } else if (a.startsWith('-')) {
      fail(`Unknown option: ${a}`, 2)
    } else {
      fail(`Unknown command: ${a}`, 2)
    }
  }
  // Resolve provider defaults (explicit --model/--base-url win over presets).
  const prov = PROVIDERS[opts.provider]
  if (!prov) fail(`Unknown provider: ${opts.provider} (expected zen or go)`, 2)
  opts.model = opts.model ?? prov.model
  opts.baseUrl = opts.baseUrl ?? prov.baseUrl
  return opts
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv)
  if (opts.help) {
    printHelp()
    return
  }
  if (opts.command === 'status') {
    cmdStatus(opts)
    return
  }
  if (opts.command === 'restore') {
    await cmdRestore(opts)
    return
  }
  await cmdPatch(opts)
}

// Only run the CLI when executed directly (not when imported by tests/tools).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(`[error] ${err && err.stack ? err.stack : err}`)
    process.exit(1)
  })
}
