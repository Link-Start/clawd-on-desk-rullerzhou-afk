const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  HOOK_GROUP_ID,
  MARKER,
  ANTIGRAVITY_HOOK_EVENTS,
  registerAntigravityHooks,
  __test,
} = require("../hooks/antigravity-install");

const tempDirs = [];

function makeTempHome({ withConfig = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-antigravity-home-"));
  tempDirs.push(home);
  if (withConfig) fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
  return home;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Antigravity hook installer", () => {
  it("installs a managed global hooks file with all hook events", () => {
    const homeDir = makeTempHome();
    const result = registerAntigravityHooks({
      silent: true,
      homeDir,
      nodeBin: "/usr/local/bin/node",
    });

    const configPath = path.join(homeDir, ".gemini", "config", "hooks.json");
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.added, 5);

    const hooks = readJson(configPath);
    assert.ok(hooks[HOOK_GROUP_ID]);
    for (const event of ANTIGRAVITY_HOOK_EVENTS) {
      assert.ok(Array.isArray(hooks[HOOK_GROUP_ID][event]), `missing ${event}`);
      const commands = [];
      for (const entry of hooks[HOOK_GROUP_ID][event]) {
        if (entry.command) commands.push(entry.command);
        if (Array.isArray(entry.hooks)) commands.push(...entry.hooks.map((hook) => hook.command));
      }
      assert.strictEqual(commands.length, 1);
      assert.ok(commands[0].includes(MARKER));
      assert.ok(commands[0].endsWith(`"${event}"`));
    }
    assert.strictEqual(hooks[HOOK_GROUP_ID].PreToolUse[0].matcher, "*");
    assert.strictEqual(hooks[HOOK_GROUP_ID].PostToolUse[0].matcher, "*");
  });

  it("is idempotent on second run", () => {
    const homeDir = makeTempHome();
    registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    const result = registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 5);
  });

  it("skips when Antigravity config is absent", () => {
    const homeDir = makeTempHome({ withConfig: false });

    const result = registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.installed, false);
    assert.strictEqual(fs.existsSync(path.join(homeDir, ".gemini", "config")), false);
  });

  it("preserves other hook groups in hooks.json", () => {
    const homeDir = makeTempHome();
    const configPath = path.join(homeDir, ".gemini", "config", "hooks.json");
    fs.writeFileSync(configPath, JSON.stringify({
      existing: {
        PreInvocation: [{ type: "command", command: "echo existing" }],
      },
    }));

    registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    const hooks = readJson(configPath);
    assert.strictEqual(hooks.existing.PreInvocation[0].command, "echo existing");
    assert.ok(hooks[HOOK_GROUP_ID]);
  });

  it("preserves a manually disabled Clawd hook group", () => {
    const homeDir = makeTempHome();
    const configPath = path.join(homeDir, ".gemini", "config", "hooks.json");
    fs.writeFileSync(configPath, JSON.stringify({ [HOOK_GROUP_ID]: { enabled: false } }));

    registerAntigravityHooks({ silent: true, homeDir, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(readJson(configPath)[HOOK_GROUP_ID].enabled, false);
  });

  it("builds Windows PowerShell commands with the event argv", () => {
    const command = __test.buildAntigravityHookCommand(
      "node",
      "D:/clawd/hooks/antigravity-hook.js",
      "PreToolUse",
      { platform: "win32" }
    );

    assert.strictEqual(command, '& "node" "D:/clawd/hooks/antigravity-hook.js" "PreToolUse"');
  });
});
