#!/usr/bin/env node
// Merge Clawd Antigravity hooks into ~/.gemini/config/hooks.json.

const fs = require("fs");
const path = require("path");
const os = require("os");
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
  return formatNodeHookCommand(nodeBin, hookScript, { ...options, args: [event] });
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
  const nodeBin = options.nodeBin !== undefined ? options.nodeBin : (resolveNodeBin() || "node");
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
    hasAntigravityConfig,
    normalizeSettings,
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
