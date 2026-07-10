"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test } = require("../hooks/claude-statusline");
const { buildStatusLineText, buildStateBody, readChainedCommand, main } = __test;

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.written = [];
  child.stdin.end = (chunk) => {
    if (chunk) child.stdin.written.push(String(chunk));
    setImmediate(() => child.emit("close", 0));
  };
  child.kill = () => {};
  return child;
}

describe("Claude Code statusline adapter", () => {
  it("builds status text from model, context percent, and weekly quota", () => {
    const text = buildStatusLineText(
      { context_window: { used_percentage: 8.4 } },
      { claudeWeekly: { usedPercent: 41 } },
      "Claude Sonnet 5"
    );
    assert.strictEqual(text, "Claude Sonnet 5 · 8% ctx · 41% weekly");
  });

  it("returns empty text when nothing is known", () => {
    assert.strictEqual(buildStatusLineText({}, null, null), "");
  });

  it("builds a metadata_only body carrying claude_quota, no event field", () => {
    const body = buildStateBody(
      { session_id: "abc123", workspace: { current_dir: "/work" } },
      { claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 } }
    );
    assert.deepStrictEqual(body, {
      state: "idle",
      preserve_state: true,
      metadata_only: true,
      session_id: "abc123",
      agent_id: "claude-code",
      claude_quota: { claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 } },
      cwd: "/work",
    });
  });

  it("returns null when there is no session id or no quota (nothing worth posting)", () => {
    assert.strictEqual(buildStateBody({}, { claudeWeekly: { usedPercent: 1 } }), null);
    assert.strictEqual(buildStateBody({ session_id: "abc" }, null), null);
  });

  it("main() posts state and always writes a stdout line", async () => {
    const writes = [];
    const posted = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(chunk); return true; };
    try {
      await main({
        payload: {
          session_id: "abc123",
          model: { display_name: "Claude Sonnet 5" },
          context_window: { used_percentage: 8 },
          rate_limits: {
            five_hour: { used_percentage: 24, resets_at: 1738425600 },
            seven_day: { used_percentage: 41 },
          },
        },
        postState: (body, options, callback) => { posted.push(JSON.parse(body)); callback(false); },
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0], "Claude Sonnet 5 · 8% ctx · 41% weekly\n");
    assert.deepStrictEqual(posted[0].claude_quota, {
      claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 },
      claudeWeekly: { usedPercent: 41 },
    });
  });

  it("main() posts nothing (but still writes stdout) when rate_limits is absent", async () => {
    const writes = [];
    let postCalled = false;
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(chunk); return true; };
    try {
      await main({
        payload: { session_id: "abc123", model: { display_name: "Claude Sonnet 5" } },
        postState: (body, options, callback) => { postCalled = true; callback(true); },
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.strictEqual(postCalled, false);
    assert.strictEqual(writes[0], "Claude Sonnet 5\n");
  });

  it("main() never throws and still writes stdout when stdin JSON read fails", async () => {
    const writes = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(chunk); return true; };
    try {
      await main({
        readStdinJson: () => Promise.reject(new Error("boom")),
        postState: (body, options, callback) => callback(true),
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0], "\n");
  });
});

describe("Claude Code statusline chain mode", () => {
  // Distinctive model name: chain tests yield the event loop (fake child
  // close is a setImmediate), so the test runner's own reporter lines can
  // land in a hijacked process.stdout.write. Assertions therefore match on
  // this marker instead of counting raw writes.
  const payload = {
    session_id: "abc123",
    model: { display_name: "ChainMarkerModel" },
    rate_limits: { five_hour: { used_percentage: 24, resets_at: 1738425600 } },
  };

  it("reads the chained command from the sidecar (statusLine object, trimmed)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-chain-"));
    const sidecarPath = path.join(dir, "clawd-statusline-chain.json");
    fs.writeFileSync(sidecarPath, JSON.stringify({
      statusLine: { type: "command", command: "  ~/.claude/my-statusline.sh  ", padding: 0 },
    }));
    assert.strictEqual(readChainedCommand(sidecarPath), "~/.claude/my-statusline.sh");
    assert.strictEqual(readChainedCommand(path.join(dir, "missing.json")), null);
  });

  it("--chain spawns the sidecar command via sh -c, re-feeds stdin, and suppresses own stdout", async () => {
    const spawns = [];
    const posted = [];
    const child = makeFakeChild();
    const writes = [];
    await main({
      payload,
      argv: ["--chain"],
      writeStdout: (chunk) => { writes.push(chunk); return true; },
      readChainedCommand: () => "bash -c 'my statusline \"quoted\"'",
      spawn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return child; },
      postState: (body, options, callback) => { posted.push(JSON.parse(body)); callback(true); },
    });

    assert.strictEqual(spawns.length, 1);
    assert.strictEqual(spawns[0].cmd, "sh");
    assert.deepStrictEqual(spawns[0].args, ["-c", "bash -c 'my statusline \"quoted\"'"]);
    assert.deepStrictEqual(spawns[0].opts.stdio, ["pipe", "inherit", "ignore"]);
    assert.deepStrictEqual(JSON.parse(child.stdin.written.join("")), payload);
    // The chained script owns the visible line - our own render never fires.
    assert.deepStrictEqual(writes, []);
    // Quota still flows.
    assert.strictEqual(posted.length, 1);
    assert.ok(posted[0].claude_quota);
  });

  it("--chain degrades to plain rendering when the sidecar is missing", async () => {
    const writes = [];
    await main({
      payload,
      argv: ["--chain"],
      writeStdout: (chunk) => { writes.push(chunk); return true; },
      readChainedCommand: () => null,
      spawn: () => { throw new Error("must not spawn"); },
      postState: (body, options, callback) => callback(true),
    });
    assert.strictEqual(writes.length, 1, "plain fallback must still render a line");
    assert.ok(String(writes[0]).includes("ChainMarkerModel"));
  });

  it("--chain kills a hung chained script after the cap instead of hanging forever", async () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {}; // never closes on its own
    let killed = null;
    child.kill = (signal) => { killed = signal; };
    await main({
      payload,
      argv: ["--chain"],
      chainCapMs: 20,
      writeStdout: () => true,
      readChainedCommand: () => "sleep 9999",
      spawn: () => child,
      postState: (body, options, callback) => callback(true),
    });
    assert.strictEqual(killed, "SIGKILL");
  });
});
