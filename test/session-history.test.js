"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HISTORY_FILE_PREFIX,
  MAX_HISTORY_AGE_MS,
  REFRESH_INTERVAL_MS,
  getHistoryFilePath,
  getBootApproxAt,
  isSameBoot,
  readHistoryFile,
  pruneHistoryFiles,
  recordSessionHistoryFromStateBody,
  loadSessionHistory,
} = require("../hooks/session-history");
const {
  updateRecoveryLeaseFromStateBody,
  loadActiveRecoveryLeases,
} = require("../hooks/session-recovery-lease");

describe("durable session history", () => {
  let historyDir;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-session-history-"));
  });

  afterEach(() => {
    fs.rmSync(historyDir, { recursive: true, force: true });
  });

  // Boot clocks are supplied explicitly so "the machine restarted" is a fact
  // of the fixture rather than of the machine running the suite. Each helper
  // names the boot its event belongs to; BOOT_B is a later, separate boot.
  const BOOT_A = T0 - 3_600_000;
  const BOOT_B = T0 + 600_000;

  function body(overrides = {}) {
    return {
      agent_id: "claude-code",
      session_id: "session-alpha",
      event: "UserPromptSubmit",
      state: "thinking",
      agent_pid: process.pid,
      source_pid: process.pid,
      cwd: "/work/project",
      session_title: "Refactor the lease store",
      ...overrides,
    };
  }

  // A write that happened at `eventAt`, during the boot that started at `boot`.
  function writeOpts(eventAt, boot = BOOT_A, extra = {}) {
    return { historyDir, eventAt, uptime: () => (eventAt - boot) / 1000, ...extra };
  }

  // A read taken at `now`, while running the boot that started at `boot`.
  function readOpts(now, boot = BOOT_A, extra = {}) {
    return { historyDir, now, uptime: () => (now - boot) / 1000, ...extra };
  }

  function readOne(sessionId = "session-alpha") {
    const filePath = getHistoryFilePath("claude-code", sessionId, { historyDir });
    return readHistoryFile(filePath);
  }

  describe("recording", () => {
    it("writes a pointer row and never conversation content", () => {
      const result = recordSessionHistoryFromStateBody(
        body({ assistant_last_output: "secret reply", prompt: "secret prompt" }),
        writeOpts(T0),
      );
      assert.equal(result.written, true);

      const record = readOne();
      assert.equal(record.sessionId, "session-alpha");
      assert.equal(record.cwd, "/work/project");
      assert.equal(record.title, "Refactor the lease store");
      assert.equal(record.lastState, "thinking");
      assert.equal(record.endedAt, null);

      const raw = fs.readFileSync(result.filePath, "utf8");
      assert.ok(!raw.includes("secret reply"));
      assert.ok(!raw.includes("secret prompt"));
    });

    it("stores files 0600 inside a 0700 directory", function () {
      if (process.platform === "win32") return; // POSIX mode bits only
      const { filePath } = recordSessionHistoryFromStateBody(body(), writeOpts(T0));
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(historyDir).mode & 0o777, 0o700);
    });

    it("debounces repeat events but always takes a changed title or state", () => {
      recordSessionHistoryFromStateBody(body(), writeOpts(T0));

      const repeat = recordSessionHistoryFromStateBody(
        body(),
        writeOpts(T0 + REFRESH_INTERVAL_MS - 1),
      );
      assert.equal(repeat.written, false);
      assert.equal(repeat.reason, "debounced");

      const renamed = recordSessionHistoryFromStateBody(
        body({ session_title: "Now something else" }),
        writeOpts(T0 + 1),
      );
      assert.equal(renamed.written, true, "an identity change must bypass the debounce");

      const later = recordSessionHistoryFromStateBody(
        body(),
        writeOpts(T0 + REFRESH_INTERVAL_MS + 1),
      );
      assert.equal(later.written, true, "the debounce window must expire");
    });

    it("keeps the original firstSeenAt across updates", () => {
      recordSessionHistoryFromStateBody(body(), writeOpts(T0));
      recordSessionHistoryFromStateBody(
        body({ state: "working" }),
        writeOpts(T0 + 60_000),
      );
      const record = readOne();
      assert.equal(record.firstSeenAt, T0);
      assert.equal(record.lastEventAt, T0 + 60_000);
    });

    it("ignores out-of-order events", () => {
      recordSessionHistoryFromStateBody(body(), writeOpts(T0 + 10_000));
      const stale = recordSessionHistoryFromStateBody(body(), writeOpts(T0));
      assert.equal(stale.written, false);
      assert.equal(stale.reason, "older-event");
      assert.equal(readOne().lastEventAt, T0 + 10_000);
    });

    it("marks a clean ending and clears it when the session speaks again", () => {
      recordSessionHistoryFromStateBody(body(), writeOpts(T0));

      recordSessionHistoryFromStateBody(
        body({ event: "SessionEnd", state: "idle" }),
        writeOpts(T0 + 1000),
      );
      assert.equal(readOne().endedAt, T0 + 1000);

      recordSessionHistoryFromStateBody(
        body({ event: "UserPromptSubmit", state: "working" }),
        writeOpts(T0 + 2000),
      );
      assert.equal(readOne().endedAt, null, "a resumed session is not an ended one");
    });

    it("refuses headless runs, foreign agents, and remote filesystems", () => {
      const cases = [
        [body({ headless: true }), "headless"],
        [body({ agent_id: "codex" }), "unsupported"],
        [body({ session_id: "default" }), "unsupported"],
        [body({ wsl_distro: "Ubuntu" }), "remote-filesystem"],
      ];
      for (const [payload, reason] of cases) {
        const result = recordSessionHistoryFromStateBody(payload, writeOpts(T0));
        assert.equal(result.written, false);
        assert.equal(result.reason, reason);
      }
      assert.equal(fs.readdirSync(historyDir).length, 0);
    });
  });

  describe("surviving a restart", () => {
    // The regression this store exists for. The lease is liveness-scoped, so
    // the first load after a reboot unlinks it; history must not follow.
    it("keeps the row that loadActiveRecoveryLeases erases after a reboot", () => {
      const deadPid = 2 ** 22; // certainly not running
      const payload = body({ agent_pid: deadPid, source_pid: deadPid });

      updateRecoveryLeaseFromStateBody(payload, {
        recoveryDir: historyDir,
        eventAt: T0,
        platform: "linux",
        getProcessStartIdentities: (pids) => new Map(pids.filter(Boolean).map((p) => [p, `linux:${p}`])),
      });
      recordSessionHistoryFromStateBody(payload, writeOpts(T0));

      // Reboot: the PID is gone, so the lease loader deletes its evidence.
      const leases = loadActiveRecoveryLeases({ recoveryDir: historyDir, now: T0 + 1000 });
      assert.equal(leases.length, 0, "the lease must not survive a dead PID");

      const history = loadSessionHistory(readOpts(BOOT_B + 60_000, BOOT_B));
      assert.equal(history.length, 1, "history must outlive the process it describes");
      assert.equal(history[0].sessionId, "session-alpha");
      assert.equal(history[0].cwd, "/work/project");
      assert.equal(history[0].interrupted, true);
    });

    it("calls a session interrupted only when it never ended and the box rebooted", () => {
      // Same boot, still open -> the lease store owns this one, not history.
      recordSessionHistoryFromStateBody(body(), writeOpts(T0));
      let rows = loadSessionHistory(readOpts(T0 + 1000, BOOT_A));
      assert.equal(rows[0].interrupted, false);

      // Rebooted since -> nothing got the chance to write an ending.
      rows = loadSessionHistory(readOpts(BOOT_B + 60_000, BOOT_B));
      assert.equal(rows[0].interrupted, true);

      // Ended cleanly, then rebooted -> not interrupted, just history.
      recordSessionHistoryFromStateBody(
        body({ event: "SessionEnd", state: "idle" }),
        writeOpts(T0 + 2000),
      );
      rows = loadSessionHistory(readOpts(BOOT_B + 60_000, BOOT_B));
      assert.equal(rows[0].interrupted, false);
    });

    it("derives boot identity without spawning a process", () => {
      const boot = getBootApproxAt({ now: T0, uptime: () => 600 });
      assert.equal(boot, T0 - 600_000);
      // Whole-second uptime and NTP steps make exact equality wrong.
      assert.ok(isSameBoot(boot, boot + 4000), "small drift is the same boot");
      assert.ok(!isSameBoot(boot, boot + 3_600_000), "an hour apart is not");
      assert.equal(getBootApproxAt({ now: T0, uptime: () => Number.NaN }), null);
    });
  });

  describe("reading", () => {
    it("ranks interrupted sessions first, then most recent", () => {
      recordSessionHistoryFromStateBody(
        body({ session_id: "old-open" }), writeOpts(T0),
      );
      recordSessionHistoryFromStateBody(
        body({ session_id: "recent-closed", event: "SessionEnd", state: "idle" }),
        writeOpts(T0 + 5000),
      );
      recordSessionHistoryFromStateBody(
        body({ session_id: "older-closed", event: "SessionEnd", state: "idle" }),
        writeOpts(T0 + 1000),
      );

      const rows = loadSessionHistory(readOpts(BOOT_B + 60_000, BOOT_B));
      assert.deepEqual(rows.map((r) => r.sessionId), ["old-open", "recent-closed", "older-closed"]);
      assert.deepEqual(rows.map((r) => r.interrupted), [true, false, false]);
    });

    it("honours limit and the agent gate", () => {
      for (let i = 0; i < 5; i++) {
        recordSessionHistoryFromStateBody(
          body({ session_id: `s-${i}` }), writeOpts(T0 + i * 1000),
        );
      }
      const limited = loadSessionHistory(readOpts(T0 + 10_000, BOOT_A, { limit: 2 }));
      assert.equal(limited.length, 2);

      const gated = loadSessionHistory(readOpts(T0 + 10_000, BOOT_A, {
        isAgentEnabled: () => false,
      }));
      assert.equal(gated.length, 0);
    });

    it("drops rows dated in the future", () => {
      recordSessionHistoryFromStateBody(body(), writeOpts(T0 + 600_000));
      const rows = loadSessionHistory(readOpts(T0, BOOT_A));
      assert.equal(rows.length, 0);
    });
  });

  describe("file hygiene", () => {
    it("rejects foreign, oversized, and misfiled records", () => {
      const valid = {
        version: 1,
        agentId: "claude-code",
        sessionId: "session-alpha",
        cwd: "/work/project",
        title: "t",
        lastState: "working",
        firstSeenAt: T0,
        lastEventAt: T0,
        endedAt: null,
        bootApproxAt: T0 - 60_000,
      };

      // A record parked under some other session's filename.
      const wrongName = path.join(historyDir, `${HISTORY_FILE_PREFIX}${"0".repeat(32)}.json`);
      fs.writeFileSync(wrongName, JSON.stringify(valid));
      assert.equal(readHistoryFile(wrongName), null);

      const goodPath = getHistoryFilePath("claude-code", "session-alpha", { historyDir });
      fs.writeFileSync(goodPath, JSON.stringify({ ...valid, extra: "unexpected" }));
      assert.equal(readHistoryFile(goodPath), null, "unknown keys must be rejected");

      fs.writeFileSync(goodPath, JSON.stringify({ ...valid, version: 2 }));
      assert.equal(readHistoryFile(goodPath), null, "a future version must be rejected");

      fs.writeFileSync(goodPath, "{ not json");
      assert.equal(readHistoryFile(goodPath), null);

      fs.writeFileSync(goodPath, JSON.stringify(valid));
      assert.notEqual(readHistoryFile(goodPath), null, "the control case must still read");
    });

    it("prunes by age and then by count, and sweeps unreadable files", () => {
      recordSessionHistoryFromStateBody(body({ session_id: "fresh" }), writeOpts(T0));
      recordSessionHistoryFromStateBody(body({ session_id: "ancient" }), writeOpts(T0));

      const junk = path.join(historyDir, `${HISTORY_FILE_PREFIX}${"f".repeat(32)}.json`);
      fs.writeFileSync(junk, "not a record");

      const wellPastRetention = T0 + MAX_HISTORY_AGE_MS + 1;
      // Only "ancient" is old; re-stamp "fresh" so it stays inside the window.
      recordSessionHistoryFromStateBody(
        body({ session_id: "fresh" }), writeOpts(wellPastRetention),
      );
      const kept = pruneHistoryFiles(historyDir, { now: wellPastRetention });
      assert.equal(kept.length, 1);
      assert.ok(!fs.existsSync(junk), "an unreadable file must not accumulate");

      const survivor = readHistoryFile(path.join(historyDir, kept[0]));
      assert.equal(survivor.sessionId, "fresh");
    });

    it("caps the directory at maxFiles, evicting the oldest", () => {
      for (let i = 0; i < 6; i++) {
        recordSessionHistoryFromStateBody(
          body({ session_id: `s-${i}` }), writeOpts(T0 + i * 1000),
        );
      }
      const kept = pruneHistoryFiles(historyDir, { now: T0 + 10_000, maxFiles: 3 });
      assert.equal(kept.length, 3);
      const survivors = kept
        .map((name) => readHistoryFile(path.join(historyDir, name)).sessionId)
        .sort();
      assert.deepEqual(survivors, ["s-3", "s-4", "s-5"]);
    });
  });
});
