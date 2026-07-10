"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  resolveCodexRateLimitQuota,
  isFreshCodexQuotaTimestamp,
  CODEX_QUOTA_MAX_AGE_MS,
} = require("../hooks/codex-rate-limits");

describe("Codex rate limit quota parser", () => {
  it("maps primary and secondary into codexFiveHour/codexWeekly, converting resets_at to epoch-ms", () => {
    // Shape captured from a real rollout token_count event (plan "plus").
    const quota = resolveCodexRateLimitQuota({
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1783669570 },
        secondary: { used_percent: 42.6, window_minutes: 10080, resets_at: 1784256370 },
        plan_type: "plus",
      },
    });

    assert.deepStrictEqual(quota, {
      codexFiveHour: { usedPercent: 1, resetAt: 1783669570 * 1000 },
      codexWeekly: { usedPercent: 43, resetAt: 1784256370 * 1000 },
    });
  });

  it("anchors a legacy relative resets_in_seconds to receive time, minute-quantized", () => {
    const nowMs = 1783600000123;
    const quota = resolveCodexRateLimitQuota(
      {
        rate_limits: {
          primary: { used_percent: 10, resets_in_seconds: 90 },
        },
      },
      { nowMs }
    );

    const resetAt = quota.codexFiveHour.resetAt;
    assert.strictEqual(resetAt % 60000, 0);
    assert.ok(Math.abs(resetAt - (nowMs + 90 * 1000)) <= 30000);
  });

  it("keeps a bucket without any reset field (usedPercent only)", () => {
    const quota = resolveCodexRateLimitQuota({
      rate_limits: { primary: { used_percent: 10 } },
    });
    assert.deepStrictEqual(quota, { codexFiveHour: { usedPercent: 10 } });
  });

  it("drops an individually malformed bucket but keeps the rest", () => {
    const quota = resolveCodexRateLimitQuota({
      rate_limits: {
        primary: { used_percent: "nope" },
        secondary: { used_percent: 5 },
      },
    });
    assert.deepStrictEqual(quota, { codexWeekly: { usedPercent: 5 } });
  });

  it("returns null when rate_limits is absent (API-key sessions, or non-token_count payloads)", () => {
    assert.strictEqual(resolveCodexRateLimitQuota({}), null);
    assert.strictEqual(resolveCodexRateLimitQuota(null), null);
    assert.strictEqual(resolveCodexRateLimitQuota({ rate_limits: {} }), null);
  });
});

describe("Codex quota capture freshness gate", () => {
  it("accepts a capture inside the max age and rejects an older one", () => {
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    assert.strictEqual(isFreshCodexQuotaTimestamp("2026-07-10T11:55:00.000Z", nowMs), true);
    assert.strictEqual(
      isFreshCodexQuotaTimestamp(new Date(nowMs - CODEX_QUOTA_MAX_AGE_MS - 1).toISOString(), nowMs),
      false
    );
  });

  it("rejects a missing or unparseable timestamp", () => {
    assert.strictEqual(isFreshCodexQuotaTimestamp(undefined), false);
    assert.strictEqual(isFreshCodexQuotaTimestamp("not-a-date"), false);
  });
});
