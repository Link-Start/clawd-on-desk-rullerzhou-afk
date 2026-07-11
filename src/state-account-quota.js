"use strict";

// ── Session-independent, per-source account quota store ──
//
// Sessions come and go (staleness sweeps evict them, the app restarts), but
// "how much of that machine's subscription is used" is not a session
// property - the headline use case is checking a remote's quota BEFORE
// starting any work there, when no session exists at all. Quota therefore
// lives here, keyed by reporting source (host prefix; null = this machine),
// and session records do not carry it.
//
// Buckets keep the absolute-resetAt convention from hooks/quota-bucket.js.
// The rate-limit windows reset on wall clock regardless of CLI activity, so
// a stored bucket whose resetAt has passed is not merely stale - it is
// wrong (it would keep showing the pre-reset high). snapshot() drops
// expired buckets and always reports the per-group updatedAt so the UI can
// label quiet sources ("as of N minutes ago") instead of presenting old
// numbers as live.
//
// Persisted to ~/.clawd/account-quota.json (same directory convention as
// runtime.json) so last-known numbers survive an app restart. Writes are
// debounced and atomic; a missing or corrupt file just means an empty
// store. Only {usedPercent, resetAt} digests and host labels are ever
// stored - no tokens, no session content.

const fs = require("fs");
const path = require("path");
const os = require("os");

const { readJsonFile } = require("../hooks/json-utils");
const { normalizeQuotaGroup } = require("../hooks/quota-bucket");
const { ANTIGRAVITY_QUOTA_FIELDS } = require("../hooks/antigravity-context-usage");
const { CLAUDE_QUOTA_FIELDS } = require("../hooks/claude-rate-limits");
const { CODEX_QUOTA_FIELDS } = require("../hooks/codex-rate-limits");

const QUOTA_PROVIDER_FIELDS = {
  antigravityQuota: ANTIGRAVITY_QUOTA_FIELDS,
  claudeQuota: CLAUDE_QUOTA_FIELDS,
  codexQuota: CODEX_QUOTA_FIELDS,
};
const QUOTA_PROVIDER_KEYS = Object.keys(QUOTA_PROVIDER_FIELDS);

const DEFAULT_PERSIST_PATH = path.join(os.homedir(), ".clawd", "account-quota.json");
const PERSIST_DEBOUNCE_MS = 2000;

// The host label is client-supplied (hooks read it from the deploy-written
// prefix file, or fall back to the remote's hostname) and every tunnel
// forwards into the same desktop port, so it cannot be origin-verified
// here — the trust boundary is "machines the user deployed Clawd hooks to",
// exactly as for the session cards' host grouping. Sanitize shape only:
// control chars stripped, length capped, so a buggy reporter cannot pollute
// the store/persist file with unbounded or unprintable keys.
const SOURCE_HOST_MAX_LENGTH = 64;

function normalizeSourceHost(host) {
  if (typeof host !== "string") return null;
  const cleaned = host.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned ? cleaned.slice(0, SOURCE_HOST_MAX_LENGTH) : null;
}

function expireBuckets(group, nowMs) {
  const out = {};
  for (const [field, bucket] of Object.entries(group)) {
    if (Number.isFinite(bucket.resetAt) && bucket.resetAt <= nowMs) continue;
    // Clone: snapshot consumers must never hold live references into the
    // store, which doubles as the persistence source of truth.
    out[field] = { ...bucket };
  }
  return Object.keys(out).length ? out : null;
}

function createAccountQuotaStore(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  // options.persistPath: undefined -> default path, null -> in-memory only.
  const persistPath = options.persistPath === undefined ? DEFAULT_PERSIST_PATH : options.persistPath;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};

  // Map<hostKey, { host, [providerKey]: { group, updatedAt } }>  ("" = local)
  const sources = new Map();
  let persistTimer = null;

  function load() {
    if (!persistPath) return;
    let raw;
    try {
      // readJsonFile, not a hand-rolled parse: BOM-safe (#590 review C3).
      raw = readJsonFile(persistPath);
    } catch {
      return; // missing or corrupt -> empty store
    }
    const entries = raw && Array.isArray(raw.sources) ? raw.sources : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const host = normalizeSourceHost(entry.host);
      const record = { host };
      let hasAny = false;
      for (const providerKey of QUOTA_PROVIDER_KEYS) {
        const stored = entry[providerKey];
        if (!stored || typeof stored !== "object") continue;
        const group = normalizeQuotaGroup(stored.group, QUOTA_PROVIDER_FIELDS[providerKey]);
        if (!group) continue;
        const updatedAt = Number(stored.updatedAt);
        record[providerKey] = {
          group,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : now(),
        };
        hasAny = true;
      }
      if (hasAny) sources.set(host || "", record);
    }
  }

  function persistNow() {
    if (!persistPath) return;
    const body = JSON.stringify({
      version: 1,
      sources: Array.from(sources.values()),
    }, null, 2);
    const dir = path.dirname(persistPath);
    const tmpPath = path.join(dir, `.account-quota.${process.pid}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, body, "utf8");
      fs.renameSync(tmpPath, persistPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      logWarn("Clawd: account-quota persist failed:", err && err.message);
    }
  }

  function schedulePersist() {
    if (!persistPath) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  // Record a quota report from one source. Returns true when anything
  // actually changed (callers broadcast only then). updatedAt is stamped
  // per provider and only on change, mirroring updateSessionMetadata's
  // discipline - an identical statusline refresh must not look "fresher".
  function update(host, quotas = {}) {
    const sourceHost = normalizeSourceHost(host);
    const key = sourceHost || "";
    let record = sources.get(key);
    let changed = false;
    for (const providerKey of QUOTA_PROVIDER_KEYS) {
      const group = normalizeQuotaGroup(quotas[providerKey], QUOTA_PROVIDER_FIELDS[providerKey]);
      if (!group) continue;
      const existing = record && record[providerKey];
      // Per-bucket merge, never group replace: real payloads legitimately
      // carry a single window (e.g. a Codex token_count with primary but no
      // secondary), and a partial report must not evict a sibling bucket
      // that is still valid — expiry, not omission, retires buckets.
      const merged = existing ? { ...existing.group, ...group } : group;
      if (existing && JSON.stringify(existing.group) === JSON.stringify(merged)) continue;
      if (!record) {
        record = { host: sourceHost };
        sources.set(key, record);
      }
      record[providerKey] = { group: merged, updatedAt: now() };
      changed = true;
    }
    if (changed) schedulePersist();
    return changed;
  }

  // Renderer-facing view: expired buckets dropped (wall-clock window reset),
  // local source first, remotes sorted by host for a stable UI order.
  function snapshot() {
    const nowMs = now();
    const out = [];
    for (const record of sources.values()) {
      const entry = { host: record.host };
      let hasAny = false;
      for (const providerKey of QUOTA_PROVIDER_KEYS) {
        const stored = record[providerKey];
        if (!stored) continue;
        const group = expireBuckets(stored.group, nowMs);
        if (!group) continue;
        entry[providerKey] = { group, updatedAt: stored.updatedAt };
        hasAny = true;
      }
      if (hasAny) out.push(entry);
    }
    out.sort((a, b) => {
      if (!a.host) return -1;
      if (!b.host) return 1;
      return a.host.localeCompare(b.host);
    });
    return out;
  }

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistNow();
  }

  load();

  return { update, snapshot, flush };
}

module.exports = {
  createAccountQuotaStore,
  QUOTA_PROVIDER_KEYS,
  DEFAULT_PERSIST_PATH,
};
