#!/usr/bin/env node
// Clawd - Claude Code statusline adapter.
// Registered as `statusLine.command` in ~/.claude/settings.json by
// hooks/install.js (registerClaudeStatusline). Claude Code pipes a JSON
// telemetry payload (model, workspace, context_window, rate_limits, etc.)
// to stdin on every statusline refresh and renders whatever we write to
// stdout as the terminal status line. See:
// https://code.claude.com/docs/en/statusline
//
// This only forwards rate_limits (Pro/Max subscription quota) - Claude
// context-window usage already flows through hooks/context-usage.js via the
// transcript, so posting context_window here too would be a redundant,
// possibly-conflicting second writer for the same field.
//
// Like antigravity-statusline.js, this script also owns rendering visible
// terminal text, so it must always print *something* fast and never throw -
// a stuck or crashed statusline script would blank out the real status line.

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { readJsonFile } = require("./json-utils");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { readStdinJson } = require("./shared-process");
const { resolveClaudeRateLimitQuota, resolveClaudeModelLabel } = require("./claude-rate-limits");

const STATE_POST_TIMEOUT_MS = 150;

// ── Chain mode (POSIX remotes only, installed via --chain-existing) ──
// The user's own statusline keeps rendering the visible line while we only
// siphon rate_limits. Their original statusLine object lives verbatim in a
// sidecar written by hooks/install.js (a file, not a CLI argument - real
// statusline commands are arbitrarily-quoted shell one-liners).
const CHAIN_SIDECAR_PATH = path.join(os.homedir(), ".claude", "hooks", "clawd-statusline-chain.json");
// A hung chained script must not accumulate orphan processes across
// statusline refreshes; well past any sane render time.
const CHAIN_EXIT_CAP_MS = 10000;

function readChainedCommand(sidecarPath) {
  try {
    // readJsonFile, not a hand-rolled parse: BOM'd JSON permanently broke
    // statusline registration once before (#590 review C3).
    const raw = readJsonFile(sidecarPath);
    const statusLine = raw && typeof raw === "object" ? raw.statusLine : null;
    const command = statusLine && typeof statusLine.command === "string" ? statusLine.command.trim() : "";
    return command || null;
  } catch {
    return null;
  }
}

// stdin is re-fed verbatim-equivalent (re-serialized payload), stdout is
// inherited (the chained script owns the visible line), stderr is swallowed
// (a broken chained script must not bleed error text into the status line
// area). Resolves on child exit so our process outlives the pipe the child
// renders through.
function runChainedStatusLine(command, stdinText, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn("sh", ["-c", command], { stdio: ["pipe", "inherit", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const cap = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve(false);
    }, Number.isFinite(deps.chainCapMs) ? deps.chainCapMs : CHAIN_EXIT_CAP_MS);
    child.on("error", () => { clearTimeout(cap); resolve(false); });
    child.on("close", () => { clearTimeout(cap); resolve(true); });
    try {
      child.stdin.on("error", () => {});
      child.stdin.end(stdinText || "");
    } catch {}
  });
}

function buildStatusLineText(payload, quota, modelLabel) {
  const parts = [];
  if (modelLabel) parts.push(modelLabel);
  const contextPercent = payload && payload.context_window && Number.isFinite(payload.context_window.used_percentage)
    ? Math.round(payload.context_window.used_percentage)
    : null;
  if (contextPercent !== null) parts.push(`${contextPercent}% ctx`);
  if (quota && quota.claudeWeekly) parts.push(`${quota.claudeWeekly.usedPercent}% weekly`);
  return parts.join(" · ");
}

function buildStateBody(payload, quota, options = {}) {
  const sessionId = payload && payload.session_id;
  if (!sessionId || !quota) return null;

  // metadata_only routes this around the updateSession lifecycle machine:
  // quota is annotated onto an existing session and dropped otherwise -
  // never creating a session, touching recentEvents, or bumping updatedAt
  // (src/server-route-state.js + state.js updateSessionMetadata).
  // state/preserve_state stay as a defensive fallback shape only.
  const body = {
    state: "idle",
    preserve_state: true,
    metadata_only: true,
    session_id: String(sessionId),
    agent_id: "claude-code",
    claude_quota: quota,
  };
  const cwd = payload && payload.workspace && typeof payload.workspace.current_dir === "string"
    ? payload.workspace.current_dir
    : "";
  if (cwd) body.cwd = cwd;
  if (options.remote) {
    body.host = options.host || readHostPrefix();
  }
  return body;
}

function postStateBody(body, deps, env) {
  if (!body) return Promise.resolve(false);
  const postState = deps.postState || postStateToRunningServer;
  return new Promise((resolve) => {
    postState(JSON.stringify(body), { timeoutMs: STATE_POST_TIMEOUT_MS, env }, (posted) => resolve(!!posted));
  });
}

async function main(deps = {}) {
  const env = deps.env || process.env;
  const argv = deps.argv || process.argv.slice(2);
  const writeStdout = deps.writeStdout || ((chunk) => process.stdout.write(chunk));
  let payload = null;
  try {
    payload = deps.payload !== undefined ? deps.payload : await (deps.readStdinJson || readStdinJson)();
  } catch {
    payload = null;
  }

  let quota = null;
  let modelLabel = null;
  let text = "";
  try {
    quota = resolveClaudeRateLimitQuota(payload);
    modelLabel = resolveClaudeModelLabel(payload);
    text = buildStatusLineText(payload, quota, modelLabel);
  } catch {
    // fall through with whatever defaults were already assigned
  }

  // Chain first, POST second: the chained script streams the user's visible
  // line as soon as it spawns, so a slow or downed tunnel can never delay
  // their rendering. Missing/unreadable sidecar degrades to plain mode
  // (rendering our own text beats a blank status line).
  let chainPromise = null;
  if (argv.includes("--chain")) {
    const chainedCommand = (deps.readChainedCommand || readChainedCommand)(
      deps.chainSidecarPath || CHAIN_SIDECAR_PATH
    );
    if (chainedCommand) {
      let stdinText = "";
      try { stdinText = payload === null ? "" : JSON.stringify(payload); } catch {}
      chainPromise = runChainedStatusLine(chainedCommand, stdinText, deps);
    }
  }

  try {
    const remote = !!env.CLAWD_REMOTE;
    const body = buildStateBody(payload, quota, {
      remote,
      host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
    });
    const postPromise = postStateBody(body, deps, env);
    if (chainPromise) await Promise.all([chainPromise, postPromise]);
    else await postPromise;
  } catch {
    // Never let a failed/slow POST take down the visible status line.
    if (chainPromise) { try { await chainPromise; } catch {} }
  }

  // In chain mode the chained script owns stdout - writing our own line too
  // would corrupt theirs.
  if (!chainPromise) writeStdout(`${text}\n`);
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write("\n");
  }).finally(() => {
    process.exit(0);
  });
}

module.exports = {
  __test: {
    buildStatusLineText,
    buildStateBody,
    postStateBody,
    readChainedCommand,
    runChainedStatusLine,
    main,
  },
};
