"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test } = require("../hooks/codex-remote-monitor");

const ROLLOUT_NAME =
  "rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl";

function tempRollout(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-"));
  const filePath = path.join(dir, ROLLOUT_NAME);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, filePath };
}

function appendLines(filePath, lines) {
  fs.appendFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const META = { type: "session_meta", payload: { cwd: "/repo" } };
const STARTED = { type: "event_msg", payload: { type: "task_started" } };
const COMPLETE = { type: "event_msg", payload: { type: "task_complete" } };
const FUNC = { type: "response_item", payload: { type: "function_call" } };

describe("Codex remote monitor", () => {
  it("builds root state bodies with headless false", () => {
    const body = JSON.parse(__test.buildPostStateBody(
      "codex:s1",
      "attention",
      "event_msg:task_complete",
      "/repo",
      false,
      "remote-box"
    ));

    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.state, "attention");
    assert.strictEqual(body.cwd, "/repo");
    assert.strictEqual(body.host, "remote-box");
    assert.strictEqual(body.headless, false);
  });

  it("builds state bodies with assistant output when provided", () => {
    const body = JSON.parse(__test.buildPostStateBody(
      "codex:s1",
      "attention",
      "event_msg:task_complete",
      "/repo",
      false,
      "remote-box",
      { assistantLastOutput: "Done from remote Codex.", assistantLastOutputTruncated: true }
    ));

    assert.strictEqual(body.assistant_last_output, "Done from remote Codex.");
    assert.strictEqual(body.assistant_last_output_truncated, true);
  });

  it("carries assistant output on remote task_complete posts", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Remote Codex answer" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    const complete = posted.find((body) => body.event === "event_msg:task_complete");
    assert.strictEqual(complete.assistant_last_output, "Remote Codex answer");
  });

  it("marks subagent bodies headless and maps task_complete to idle", () => {
    const entry = {
      sessionId: "codex:sub",
      cwd: "",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box"
      )));
    };

    __test.processLine(JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/repo/sub",
        source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "worker" } } },
        agent_role: "worker",
      },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    assert.strictEqual(posted[0].state, "idle");
    assert.strictEqual(posted[0].headless, true);
    assert.strictEqual(posted[1].state, "idle");
    assert.strictEqual(posted[1].event, "event_msg:task_complete");
    assert.strictEqual(posted[1].headless, true);
  });

  it("builds metadata_only quota bodies on the lifecycle session_id namespace", () => {
    const body = JSON.parse(__test.buildPostQuotaBody(
      "codex:s1",
      {
        codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
        codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
      },
      "remote-box"
    ));

    assert.strictEqual(body.metadata_only, true);
    assert.strictEqual(body.preserve_state, true);
    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.session_id, "codex:s1");
    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.host, "remote-box");
    assert.deepStrictEqual(body.codex_quota, {
      codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
      codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
    });
    assert.strictEqual(body.event, undefined);
  });

  it("posts quota for fresh token_count lines and drops stale replays", () => {
    const entry = {
      sessionId: "codex:s1",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const stateCalls = [];
    const quotaCalls = [];
    const options = {
      postState: (...args) => stateCalls.push(args),
      postQuota: (...args) => quotaCalls.push(args),
    };
    const rateLimits = {
      primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1783669570 },
      secondary: { used_percent: 42.6, window_minutes: 10080, resets_at: 1784256370 },
    };

    __test.processLine(JSON.stringify({
      type: "event_msg",
      timestamp: new Date().toISOString(),
      payload: { type: "token_count", rate_limits: rateLimits },
    }), entry, options);
    __test.processLine(JSON.stringify({
      type: "event_msg",
      // A restart replay: pollFile re-reads recent files from offset 0.
      timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: rateLimits },
    }), entry, options);

    // token_count is telemetry: no lifecycle post either way.
    assert.strictEqual(stateCalls.length, 0);
    assert.deepStrictEqual(quotaCalls, [
      ["codex:s1", {
        codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
        codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
      }],
    ]);
  });
});

describe("Codex remote monitor — stale-cleanup re-read dedup", () => {
  const tmpDirs = [];
  afterEach(() => {
    __test.tracked.clear();
    while (tmpDirs.length) {
      try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  function track(lines) {
    const { dir, filePath } = tempRollout(lines);
    tmpDirs.push(dir);
    return filePath;
  }

  function spy() {
    const posted = [];
    return {
      posted,
      postState: (sessionId, state, event) => posted.push({ sessionId, state, event }),
    };
  }

  it("does not re-emit historical task_complete after a stale window + resume", () => {
    const filePath = track([META, STARTED, COMPLETE]);
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const completes1 = s.posted.filter((p) => p.event === "event_msg:task_complete");
    assert.strictEqual(completes1.length, 1, "first completion fires once");

    // Idle past the stale threshold: posts sleeping once, KEEPS the entry+offset.
    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });
    assert.strictEqual(
      s.posted.filter((p) => p.event === "stale-cleanup").length, 1,
      "sleeping posted once on going stale"
    );

    // Resume appends a brand-new line. The retained offset means only this new
    // line is processed — the old task_complete is never re-read.
    appendLines(filePath, [STARTED]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 1,
      "historical task_complete must not re-fire on resume"
    );
  });

  it("still fires a genuinely new completion after resume", () => {
    const filePath = track([META, STARTED, COMPLETE]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });

    // The resumed turn completes again — a real second completion.
    appendLines(filePath, [STARTED, COMPLETE]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 2,
      "a real new completion after resume still fires"
    );
  });

  it("posts sleeping only once while a session stays idle", () => {
    const filePath = track([META, STARTED]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    const future = () => Date.now() + __test.STALE_MS + 1;
    __test.cleanStaleFiles({ postState: s.postState, now: future });
    __test.cleanStaleFiles({ postState: s.postState, now: future });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "stale-cleanup").length, 1,
      "stale-cleanup must not re-post sleeping every tick"
    );
  });

  it("re-reads from 0 when the rollout file is truncated/rotated", () => {
    const filePath = track([META, STARTED]); // idle, thinking
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(s.posted.filter((p) => p.event === "event_msg:task_complete").length, 0);

    // Recreate the file smaller than the retained offset (rotation/truncation).
    fs.writeFileSync(filePath, JSON.stringify(COMPLETE) + "\n");
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 1,
      "truncated file must restart at offset 0 instead of skipping new content"
    );
  });

  it("wakes a stale session on the next working event", () => {
    const filePath = track([META, FUNC]); // idle, working
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const workingBefore = s.posted.filter((p) => p.state === "working").length;
    assert.strictEqual(workingBefore, 1);

    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });
    assert.strictEqual(__test.tracked.get(filePath).stale, true);

    // Same working-mapped event after going stale must wake the pet, not be
    // swallowed by the same-state dedup.
    appendLines(filePath, [FUNC]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.state === "working").length, 2,
      "next working event after stale must re-post working"
    );
    assert.strictEqual(__test.tracked.get(filePath).stale, false, "stale cleared on wake");
  });

  it("prunes tracked entries whose directory left the scan window", () => {
    const filePath = track([META, STARTED]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(__test.tracked.has(filePath), true);

    // Simulate the day rolling over: the file's dir is no longer in-window.
    __test.pruneTrackedOutOfWindow({ getSessionDirs: () => ["/some/other/window/dir"] });
    assert.strictEqual(__test.tracked.has(filePath), false, "out-of-window entry pruned");
  });
});
