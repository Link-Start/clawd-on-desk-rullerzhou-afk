"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAccountQuotaStore } = require("../src/state-account-quota");

function tempPersistPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-account-quota-")), "account-quota.json");
}

describe("account quota store", () => {
  it("stores per-source groups and reports change only on real change", () => {
    let nowMs = 1000000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    const group = { claudeWeekly: { usedPercent: 41, resetAt: 2000000 } };

    assert.strictEqual(store.update("pi", { claudeQuota: group }), true);
    nowMs = 1001000;
    assert.strictEqual(store.update("pi", { claudeQuota: group }), false, "identical refresh is a no-op");

    const snapshot = store.snapshot();
    assert.strictEqual(snapshot.length, 1);
    assert.strictEqual(snapshot[0].host, "pi");
    assert.deepStrictEqual(snapshot[0].claudeQuota.group, group);
    assert.strictEqual(snapshot[0].claudeQuota.updatedAt, 1000000, "no-op refresh must not look fresher");
  });

  it("normalizes empty/whitespace hosts to the local source and sorts local first", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update("zeta", { codexQuota: { codexWeekly: { usedPercent: 43, resetAt: 5000 } } });
    store.update("  ", { codexQuota: { codexWeekly: { usedPercent: 7, resetAt: 5000 } } });
    store.update("alpha", { codexQuota: { codexWeekly: { usedPercent: 9, resetAt: 5000 } } });

    assert.deepStrictEqual(store.snapshot().map((e) => e.host), [null, "alpha", "zeta"]);
  });

  it("drops expired buckets at snapshot time and whole providers when nothing survives", () => {
    let nowMs = 1000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update(null, {
      claudeQuota: {
        claudeFiveHour: { usedPercent: 80, resetAt: 2000 },
        claudeWeekly: { usedPercent: 41, resetAt: 999999 },
      },
      codexQuota: { codexFiveHour: { usedPercent: 12, resetAt: 2000 } },
    });

    nowMs = 3000; // both five-hour windows have reset on wall clock
    const snapshot = store.snapshot();
    assert.strictEqual(snapshot.length, 1);
    assert.deepStrictEqual(snapshot[0].claudeQuota.group, {
      claudeWeekly: { usedPercent: 41, resetAt: 999999 },
    });
    assert.strictEqual(snapshot[0].codexQuota, undefined, "fully expired provider disappears");
  });

  it("ignores unknown provider keys and invalid groups", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    assert.strictEqual(store.update("pi", {
      bogusQuota: { x: { usedPercent: 1 } },
      claudeQuota: { claudeWeekly: { usedPercent: "nope" } },
    }), false);
    assert.deepStrictEqual(store.snapshot(), []);
  });

  it("persists on flush and reloads last-known numbers (app-restart survival)", () => {
    const persistPath = tempPersistPath();
    const group = { claudeWeekly: { usedPercent: 41, resetAt: 9999999 } };
    const store = createAccountQuotaStore({ persistPath, now: () => 1234 });
    store.update("pi", { claudeQuota: group });
    store.flush();

    const reloaded = createAccountQuotaStore({ persistPath, now: () => 5678 });
    const snapshot = reloaded.snapshot();
    assert.strictEqual(snapshot.length, 1);
    assert.strictEqual(snapshot[0].host, "pi");
    assert.deepStrictEqual(snapshot[0].claudeQuota.group, group);
    assert.strictEqual(snapshot[0].claudeQuota.updatedAt, 1234, "persisted stamp survives reload");
  });

  it("treats a missing or corrupt persist file as an empty store", () => {
    const persistPath = tempPersistPath();
    assert.deepStrictEqual(createAccountQuotaStore({ persistPath, now: () => 1 }).snapshot(), []);

    fs.writeFileSync(persistPath, "{not json");
    assert.deepStrictEqual(createAccountQuotaStore({ persistPath, now: () => 1 }).snapshot(), []);
  });
});
