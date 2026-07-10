"use strict";

const { normalizeQuotaGroup, anchorRelativeResetAt } = require("./quota-bucket");

// Codex CLI has no statusline mechanism (its lifecycle hooks carry no rate
// limit data either), so its Plus/Pro subscription quota rides the rollout
// JSONL `token_count` events (payload.rate_limits) that the local and remote
// log monitors already tail. Field names verified against real rollout files
// (Codex CLI, 2026-07, plan "plus"):
//   primary:   { used_percent, window_minutes: 300,   resets_at (epoch-s) }
//   secondary: { used_percent, window_minutes: 10080, resets_at (epoch-s) }
// used_percent is already 0-100 "used" (the quota-bucket.js convention), and
// current CLIs emit an absolute resets_at converted to epoch-ms here, exactly
// like Claude's. Older builds emitted a relative resets_in_seconds instead;
// that fallback is anchored + minute-quantized on receipt (see
// quota-bucket.js anchorRelativeResetAt for why quantization matters).
const CODEX_QUOTA_FIELDS = ["codexFiveHour", "codexWeekly"];
const RATE_LIMIT_KEYS = {
  primary: "codexFiveHour",
  secondary: "codexWeekly",
};

// Rollout files are re-read from offset 0 after a monitor restart, so an old
// token_count line can be parsed long after it was written. Posting it would
// stamp a fresh metadataUpdatedAt on stale quota and beat genuinely fresher
// reporters in the dashboard's freshest-wins arbitration - callers drop
// captures older than this instead. Both timestamps come from the same
// machine's clock (the monitor runs where the rollout is written), so no
// cross-host skew is involved.
const CODEX_QUOTA_MAX_AGE_MS = 10 * 60 * 1000;

function convertCodexRateLimitsPayload(rateLimits, nowMs) {
  const out = {};
  for (const [key, field] of Object.entries(RATE_LIMIT_KEYS)) {
    const bucket = rateLimits[key];
    if (!bucket || typeof bucket !== "object") continue;
    const usedPercent = Number(bucket.used_percent);
    if (!Number.isFinite(usedPercent)) continue;
    const entry = { usedPercent };
    const resetsAt = Number(bucket.resets_at);
    if (Number.isFinite(resetsAt)) {
      entry.resetAt = resetsAt * 1000;
    } else {
      const resetAt = anchorRelativeResetAt(bucket.resets_in_seconds, nowMs);
      if (resetAt !== null) entry.resetAt = resetAt;
    }
    out[field] = entry;
  }
  return out;
}

function resolveCodexRateLimitQuota(payload, options = {}) {
  const rateLimits = payload && typeof payload.rate_limits === "object" ? payload.rate_limits : null;
  if (!rateLimits) return null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  return normalizeQuotaGroup(convertCodexRateLimitsPayload(rateLimits, nowMs), CODEX_QUOTA_FIELDS);
}

// Freshness gate for the rollout line's own envelope timestamp.
function isFreshCodexQuotaTimestamp(timestamp, nowMs = Date.now()) {
  const capturedAt = Date.parse(timestamp);
  if (!Number.isFinite(capturedAt)) return false;
  return nowMs - capturedAt <= CODEX_QUOTA_MAX_AGE_MS;
}

module.exports = {
  resolveCodexRateLimitQuota,
  isFreshCodexQuotaTimestamp,
  CODEX_QUOTA_FIELDS,
  CODEX_QUOTA_MAX_AGE_MS,
};
