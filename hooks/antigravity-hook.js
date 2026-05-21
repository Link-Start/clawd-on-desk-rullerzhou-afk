#!/usr/bin/env node
// Clawd - Antigravity CLI hook adapter
// Registered in Antigravity's global hooks file by hooks/antigravity-install.js

const path = require("path");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const HOOK_MAP = {
  PreInvocation: { state: "thinking", event: "UserPromptSubmit" },
  PreToolUse: { state: "working", event: "PreToolUse" },
  PostToolUse: { state: "working", event: "PostToolUse" },
  PostInvocation: { state: "idle", event: "AfterAgent" },
  Stop: { state: "attention", event: "Stop" },
};

const config = getPlatformConfig();

function isAntigravityAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return /(^|[\s"'/])agy(\.exe)?($|[\s"'/])/.test(normalized)
    || normalized.includes("/agy/bin/agy.exe")
    || normalized.includes("/antigravity-cli/");
}

const resolve = createPidResolver({
  agentNames: { win: new Set(["agy.exe"]), mac: new Set(["agy"]), linux: new Set(["agy"]) },
  agentCmdlineCheck: isAntigravityAgentCommandLine,
  platformConfig: config,
});

function stdoutForEvent(hookName) {
  if (hookName === "PreToolUse") return JSON.stringify({ decision: "ask" });
  if (hookName === "Stop") return JSON.stringify({ decision: "allow" });
  return "{}";
}

function resolveHookName(payload, argvEvent) {
  return (payload && payload.hookEventName) || (payload && payload.hook_event_name) || argvEvent || "";
}

function shouldResolvePid(hookName, env = process.env) {
  return !!HOOK_MAP[hookName] && !env.CLAWD_REMOTE;
}

function normalizeSessionId(value, payload) {
  const fallback = payload && typeof payload.transcriptPath === "string" && payload.transcriptPath
    ? path.basename(path.dirname(payload.transcriptPath)) || "default"
    : "default";
  const raw = value != null && value !== "" ? String(value) : fallback;
  return raw.startsWith("antigravity:") ? raw : `antigravity:${raw}`;
}

function resolveCwd(payload) {
  const toolArgs = payload && payload.toolCall && payload.toolCall.args;
  if (toolArgs && typeof toolArgs.Cwd === "string" && toolArgs.Cwd) return toolArgs.Cwd;
  if (payload && Array.isArray(payload.workspacePaths)) {
    const first = payload.workspacePaths.find((entry) => typeof entry === "string" && entry);
    if (first) return first;
  }
  return "";
}

function hasToolError(payload) {
  if (!payload || typeof payload !== "object") return false;
  const error = payload.error;
  return error !== undefined && error !== null && error !== false && error !== "";
}

function hasStopError(payload) {
  if (hasToolError(payload)) return true;
  const reason = payload && typeof payload.terminationReason === "string"
    ? payload.terminationReason.toLowerCase()
    : "";
  return reason.includes("error") || reason.includes("failed") || reason.includes("failure");
}

function resolveHookMapping(hookName, payload) {
  const mapped = HOOK_MAP[hookName];
  if (!mapped) return null;

  if (hookName === "PostToolUse" && hasToolError(payload)) {
    return { state: "error", event: "PostToolUseFailure" };
  }
  if (hookName === "Stop" && hasStopError(payload)) {
    return { state: "error", event: "StopFailure" };
  }
  if (hookName === "Stop" && payload && payload.fullyIdle === false) {
    return { state: "working", event: "PostToolUse" };
  }

  return mapped;
}

function buildStateBody(hookName, payload, options = {}) {
  const mapped = resolveHookMapping(hookName, payload);
  if (!mapped) return null;

  const { state, event } = mapped;
  const sessionId = normalizeSessionId(payload && payload.conversationId, payload);
  const cwd = resolveCwd(payload);
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "antigravity-cli",
  };

  if (cwd) body.cwd = cwd;

  if (options.remote) {
    body.host = options.host || readHostPrefix();
    return body;
  }

  const pidMeta = options.pidMeta;
  if (!pidMeta || typeof pidMeta !== "object") return body;
  if (Number.isFinite(pidMeta.stablePid) && pidMeta.stablePid > 0) body.source_pid = Math.floor(pidMeta.stablePid);
  if (pidMeta.detectedEditor) body.editor = pidMeta.detectedEditor;
  if (Number.isFinite(pidMeta.agentPid) && pidMeta.agentPid > 0) body.agent_pid = Math.floor(pidMeta.agentPid);
  if (Array.isArray(pidMeta.pidChain) && pidMeta.pidChain.length) body.pid_chain = pidMeta.pidChain;
  return body;
}

function sendHookEvent(payload, argvEvent, deps = {}) {
  const env = deps.env || process.env;
  const hookName = resolveHookName(payload, argvEvent);
  const outLine = stdoutForEvent(hookName);
  const remote = !!env.CLAWD_REMOTE;
  const body = buildStateBody(hookName, payload || {}, {
    remote,
    host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
    pidMeta: shouldResolvePid(hookName, env)
      ? (deps.resolvePid ? deps.resolvePid() : undefined)
      : undefined,
  });

  if (!body) {
    return Promise.resolve({ hookName, stdout: outLine, body: null, posted: false, port: null });
  }

  const postState = deps.postState || postStateToRunningServer;
  return new Promise((resolvePost) => {
    postState(JSON.stringify(body), { timeoutMs: 100 }, (posted, port) => {
      resolvePost({ hookName, stdout: outLine, body, posted: !!posted, port: port || null });
    });
  });
}

async function main(argvEvent = process.argv[2], deps = {}) {
  const payload = deps.payload !== undefined
    ? deps.payload
    : await (deps.readStdinJson || readStdinJson)();
  const result = await sendHookEvent(payload, argvEvent, {
    env: deps.env || process.env,
    postState: deps.postState || postStateToRunningServer,
    readHostPrefix: deps.readHostPrefix || readHostPrefix,
    resolvePid: deps.resolvePid || resolve,
  });
  process.stdout.write(result.stdout + "\n");
}

if (require.main === module) {
  main().then(() => {
    process.exit(0);
  });
}

module.exports = {
  __test: {
    buildStateBody,
    resolveHookName,
    resolveCwd,
    sendHookEvent,
    shouldResolvePid,
    stdoutForEvent,
    isAntigravityAgentCommandLine,
  },
};
