const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { __test } = require("../hooks/antigravity-hook");

function runAntigravityHook(argvEvent, payload = {}) {
  const scriptPath = path.resolve(__dirname, "..", "hooks", "antigravity-hook.js");
  const httpBlockerPath = path.resolve(__dirname, "hook-http-blocker.js");
  return spawnSync(process.execPath, ["--require", httpBlockerPath, scriptPath, argvEvent], {
    env: { ...process.env, CLAWD_REMOTE: "1" },
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("Antigravity hook script", () => {
  it("writes ask JSON for PreToolUse so agy keeps native permission handling", () => {
    const result = runAntigravityHook("PreToolUse", { conversationId: "c1" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, "");
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: "ask" });
  });

  it("posts Antigravity conversation ids and workspace cwd", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      conversationId: "c1",
      workspacePaths: [process.cwd()],
    }, "PreInvocation", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].agent_id, "antigravity-cli");
    assert.strictEqual(postedBodies[0].session_id, "antigravity:c1");
    assert.strictEqual(postedBodies[0].state, "thinking");
    assert.strictEqual(postedBodies[0].event, "UserPromptSubmit");
    assert.strictEqual(postedBodies[0].cwd, process.cwd());
  });

  it("uses tool Cwd before workspace paths", () => {
    assert.strictEqual(
      __test.resolveCwd({
        workspacePaths: ["/workspace"],
        toolCall: { args: { Cwd: "/tool-cwd" } },
      }),
      "/tool-cwd"
    );
  });

  it("maps PostToolUse errors to PostToolUseFailure", async () => {
    const postedBodies = [];
    await __test.sendHookEvent({
      conversationId: "c1",
      workspacePaths: [process.cwd()],
      error: "tool failed",
    }, "PostToolUse", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "error");
    assert.strictEqual(postedBodies[0].event, "PostToolUseFailure");
  });

  it("maps fully idle Stop to the shared done event", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      conversationId: "c1",
      fullyIdle: true,
    }, "Stop", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, JSON.stringify({ decision: "allow" }));
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "attention");
    assert.strictEqual(postedBodies[0].event, "Stop");
  });

  it("keeps non-idle Stop as working while background tasks remain", async () => {
    const postedBodies = [];
    await __test.sendHookEvent({
      conversationId: "c1",
      fullyIdle: false,
    }, "Stop", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "working");
    assert.strictEqual(postedBodies[0].event, "PostToolUse");
  });

  it("recognizes agy command lines for agent PID tracking", () => {
    assert.strictEqual(__test.isAntigravityAgentCommandLine('"C:/Users/me/AppData/Local/agy/bin/agy.exe"'), true);
    assert.strictEqual(__test.isAntigravityAgentCommandLine('"node" "D:/animation/hooks/antigravity-hook.js" "Stop"'), false);
  });

  it("fails open when local hook setup throws", () => {
    const scriptPath = path.resolve(__dirname, "..", "hooks", "antigravity-hook.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-antigravity-hook-"));
    const preloadPath = path.join(tmpDir, "preload.js");
    const preload = `
      const Module = require("module");
      const original = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request.endsWith("./shared-process") || request.endsWith("/shared-process")) {
          return {
            getPlatformConfig: () => ({}),
            readStdinJson: () => Promise.reject(new Error("stdin failed")),
            createPidResolver: () => () => { throw new Error("pid failed"); },
          };
        }
        return original.apply(this, arguments);
      };
    `;
    fs.writeFileSync(preloadPath, preload);
    const result = spawnSync(process.execPath, ["--require", preloadPath, scriptPath, "PreToolUse"], {
      input: JSON.stringify({ conversationId: "c1" }),
      encoding: "utf8",
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, "");
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: "ask" });
  });
});
