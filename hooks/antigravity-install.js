#!/usr/bin/env node
// Merge Clawd Antigravity hooks into ~/.gemini/config/hooks.json.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync: defaultExecFileSync } = require("child_process");
const { resolveNodeBin } = require("./server-config");
const { writeJsonAtomic, asarUnpackedPath, formatNodeHookCommand } = require("./json-utils");

const HOOK_GROUP_ID = "clawd";
const MARKER = "antigravity-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".gemini", "config");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");

const ANTIGRAVITY_HOOK_EVENTS = [
  "PreInvocation",
  "PreToolUse",
  "PostToolUse",
  "PostInvocation",
  "Stop",
];

function buildAntigravityHookCommand(nodeBin, hookScript, event, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return buildWindowsAntigravityHookCommand(nodeBin, hookScript, event, options);
  }
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    args: [event],
  });
}

function quotePowerShellSingleArg(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsPowerShellBin(options = {}) {
  if (options.powerShellBin) return options.powerShellBin;
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function buildWindowsAntigravityHookCommand(nodeBin, hookScript, event, options = {}) {
  const psCommand = [
    "&",
    quotePowerShellSingleArg(nodeBin),
    quotePowerShellSingleArg(hookScript),
    quotePowerShellSingleArg(event),
  ].join(" ");
  const encodedCommand = Buffer.from(psCommand, "utf16le").toString("base64");
  return `${windowsPowerShellBin(options)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
}

function isNodeExecutablePath(value) {
  return /(?:^|[\\/])node(?:\.exe)?$/i.test(String(value || ""));
}

function firstNonEmptyLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function resolveWindowsNodeBin(options = {}) {
  const execPath = options.execPath || process.execPath;
  if (isNodeExecutablePath(execPath)) return execPath;

  const execFileSync = options.execFileSync || defaultExecFileSync;
  try {
    const whereExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "where.exe")
      : "where.exe";
    const output = execFileSync(whereExe, ["node"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    const resolved = firstNonEmptyLine(output);
    if (resolved) return resolved;
  } catch {}

  return null;
}

function resolveAntigravityNodeBin(options = {}) {
  if (options.nodeBin !== undefined) return options.nodeBin;
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return resolveWindowsNodeBin(options) || resolveNodeBin(options) || "node";
  }
  return resolveNodeBin(options) || "node";
}

function buildHookHandler(command) {
  return { type: "command", command, timeout: 10 };
}

function buildAntigravityHooks(commandForEvent) {
  return {
    clawd: {
      PreInvocation: [buildHookHandler(commandForEvent("PreInvocation"))],
      PreToolUse: [{
        matcher: "*",
        hooks: [buildHookHandler(commandForEvent("PreToolUse"))],
      }],
      PostToolUse: [{
        matcher: "*",
        hooks: [buildHookHandler(commandForEvent("PostToolUse"))],
      }],
      PostInvocation: [buildHookHandler(commandForEvent("PostInvocation"))],
      Stop: [buildHookHandler(commandForEvent("Stop"))],
    },
  };
}

function hasAntigravityConfig(homeDir) {
  return fs.existsSync(path.join(homeDir, ".gemini", "config"));
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function normalizeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function registerAntigravityHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configPath = options.configPath || path.join(homeDir, ".gemini", "config", "hooks.json");

  if (!options.configPath && !hasAntigravityConfig(homeDir)) {
    if (!options.silent) console.log("Clawd: Antigravity config not found - skipping Antigravity hook registration");
    return { installed: false, added: 0, updated: 0, skipped: 0, configPath };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "antigravity-hook.js").replace(/\\/g, "/"));
  const nodeBin = resolveAntigravityNodeBin(options);
  const desiredGroup = buildAntigravityHooks((event) => buildAntigravityHookCommand(nodeBin, hookScript, event, options))[HOOK_GROUP_ID];
  const settings = normalizeSettings(readJsonIfExists(configPath));
  const existingGroup = settings[HOOK_GROUP_ID] && typeof settings[HOOK_GROUP_ID] === "object" && !Array.isArray(settings[HOOK_GROUP_ID])
    ? settings[HOOK_GROUP_ID]
    : null;

  let added = 0;
  let updated = 0;
  let skipped = 0;

  if (existingGroup && existingGroup.enabled === false) {
    desiredGroup.enabled = false;
  }

  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const existingText = existingGroup ? JSON.stringify(existingGroup[event]) : null;
    const nextText = JSON.stringify(desiredGroup[event]);
    if (existingText === nextText) {
      skipped++;
    } else if (existingText === null) {
      added++;
    } else {
      updated++;
    }
  }

  const changed = !existingGroup || JSON.stringify(existingGroup) !== JSON.stringify(desiredGroup);
  if (changed) {
    settings[HOOK_GROUP_ID] = desiredGroup;
    writeJsonAtomic(configPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Antigravity hooks -> ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { installed: true, added, updated, skipped, configPath };
}

module.exports = {
  HOOK_GROUP_ID,
  MARKER,
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  ANTIGRAVITY_HOOK_EVENTS,
  registerAntigravityHooks,
  __test: {
    buildAntigravityHookCommand,
    buildAntigravityHooks,
    buildWindowsAntigravityHookCommand,
    hasAntigravityConfig,
    normalizeSettings,
    resolveAntigravityNodeBin,
    resolveWindowsNodeBin,
  },
};

if (require.main === module) {
  try {
    registerAntigravityHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
