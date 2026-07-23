"use strict";

const { canOfferLocalFolder, focusUnavailableReasonKey } = globalThis.ClawdSessionFocusUnavailable;

const HUD_MAX_EXPANDED_ROWS = 3;
const HUD_MAX_EXPANDED_ROWS_LABELS = 5;
const HUD_TITLE_MAX_UNITS = 15;
const RECENT_DONE_UNREAD_MS = 60 * 1000;
const SESSION_ACTION_FEEDBACK_MS = 4000;

let snapshot = { sessions: [], orderedIds: [], hudTotalNonIdle: 0, hudLastTitle: null, hudShowStateLabels: true, hudShowElapsed: true, hudShowContextUsage: true, hudShowQuota: true, hudPinned: false, accountQuota: [] };
let i18nPayload = { lang: "en", translations: {} };

const unreadSessions = new Set();
const prevBadges = new Map();
const pendingFolderSessions = new Set();
let sessionActionFeedback = null;
let sessionActionFeedbackTimer = null;

const hudEl = document.getElementById("hud");

function isHudSession(session) {
  return !!session && !session.headless && session.state !== "sleeping" && !session.hiddenFromHud;
}

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return t("sessionJustNow");
  if (sec < 60) return t("sessionHudElapsedSec").replace("{n}", sec);
  const min = Math.floor(sec / 60);
  if (min < 5) {
    const secRem = sec % 60;
    return t("sessionHudElapsedMinSec")
      .replace("{m}", min)
      .replace("{s}", secRem);
  }
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return t("sessionHrAgo").replace("{n}", hr);
}

function formatTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1000000) {
    const formatted = (n / 1000000).toFixed(n >= 10000000 ? 0 : 1);
    return `${formatted.replace(/\.0$/, "")}m`;
  }
  if (n >= 1000) {
    const formatted = (n / 1000).toFixed(n >= 10000 ? 0 : 1);
    return `${formatted.replace(/\.0$/, "")}k`;
  }
  return String(Math.round(n));
}

function titleFor(session) {
  return session.displayTitle || session.sessionTitle || session.id || "";
}

function titleUnits(value) {
  let units = 0;
  for (const ch of String(value || "")) {
    if (/\s/.test(ch)) units += 0.5;
    else units += ch.charCodeAt(0) > 0x7F ? 2 : 1;
  }
  return units;
}

function shortenHudTitle(value) {
  const full = String(value || "").replace(/\s+/g, " ").trim();
  if (!full || titleUnits(full) <= HUD_TITLE_MAX_UNITS) return full;

  let units = 0;
  let out = "";
  for (const ch of full) {
    const nextUnits = /\s/.test(ch) ? 0.5 : (ch.charCodeAt(0) > 0x7F ? 2 : 1);
    if (units + nextUnits > HUD_TITLE_MAX_UNITS) break;
    out += ch;
    units += nextUnits;
  }

  let trimmed = out.trimEnd();
  const next = full[trimmed.length] || "";
  if (/[A-Za-z0-9]/.test(trimmed.slice(-1)) && /[A-Za-z0-9]/.test(next)) {
    const wordTrimmed = trimmed.replace(/\s+\S*$/, "").trimEnd();
    if (wordTrimmed && titleUnits(wordTrimmed) >= HUD_TITLE_MAX_UNITS * 0.55) {
      trimmed = wordTrimmed;
    }
  }
  return `${trimmed}\u2026`;
}

function orderedHudSessions(currentSnapshot) {
  const sessions = Array.isArray(currentSnapshot.sessions) ? currentSnapshot.sessions : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const ids = Array.isArray(currentSnapshot.orderedIds)
    ? currentSnapshot.orderedIds
    : sessions.map((session) => session.id);
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const orderedIds = new Set(ordered.map((session) => session.id));
  const missing = sessions.filter((session) => !orderedIds.has(session.id));
  return ordered.concat(missing).filter(isHudSession);
}

const STATE_CHIP_MAP = {
  thinking: { key: "sessionThinking", cls: "chip-thinking" },
  working: { key: "sessionWorking", cls: "chip-working" },
  juggling: { key: "sessionJuggling", cls: "chip-juggling" },
};

const EVENT_CHIP_MAP = {
  PreCompact: { key: "sessionSweeping", cls: "chip-sweeping" },
  PreCompress: { key: "sessionSweeping", cls: "chip-sweeping" },
  PermissionRequest: { key: "sessionNotification", cls: "chip-notification" },
  Elicitation: { key: "sessionNotification", cls: "chip-notification" },
  Notification: { key: "sessionNotification", cls: "chip-notification" },
  WorktreeCreate: { key: "sessionWorktree", cls: "chip-worktree" },
};

function makeChipInfo(entry) {
  return entry ? { label: t(entry.key), cls: entry.cls } : null;
}

function stateChipInfo(session) {
  if (snapshot.hudShowStateLabels === false) {
    return session && session.startupRecovered
      ? { label: t("sessionRecovered"), cls: "chip-recovered" }
      : null;
  }
  const rawEvent = session && session.lastEvent && session.lastEvent.rawEvent;
  const eventChip = makeChipInfo(EVENT_CHIP_MAP[rawEvent]);
  if (eventChip && session.badge !== "done" && session.badge !== "interrupted") return eventChip;

  if (session.badge === "running") {
    const stateChip = makeChipInfo(STATE_CHIP_MAP[session.state]);
    if (stateChip) {
      return session.startupRecovered
        ? { label: `${t("sessionRecovered")} · ${stateChip.label}`, cls: `${stateChip.cls} chip-recovered` }
        : stateChip;
    }
    if (session.startupRecovered) return { label: t("sessionRecovered"), cls: "chip-recovered" };
    return { label: t("sessionBadgeRunning"), cls: "chip-working" };
  }
  if (session.badge === "interrupted") {
    return { label: t("sessionBadgeInterrupted"), cls: "chip-interrupted" };
  }
  return null;
}

function usageChipInfo(session) {
  if (snapshot.hudShowContextUsage === false) return null;
  const usage = session && session.contextUsage;
  if (!usage || !Number.isFinite(Number(usage.used))) return null;
  const usedLabel = formatTokenCount(usage.used);
  const percentKnown = Number.isFinite(Number(usage.percent));
  if (percentKnown) {
    const percent = Math.max(0, Math.min(100, Math.round(Number(usage.percent))));
    const hasLimit = Number.isFinite(Number(usage.limit));
    return {
      label: `${percent}%`,
      cls: percent >= 90 ? "usage-hot" : (percent >= 75 ? "usage-warm" : "usage-neutral"),
      title: hasLimit
        ? t("sessionHudContextUsageTooltip")
          .replace("{used}", usedLabel)
          .replace("{limit}", formatTokenCount(usage.limit))
          .replace("{percent}", percent)
        : t("sessionHudContextUsageTooltipUnknownLimit").replace("{used}", usedLabel),
    };
  }
  return {
    label: usedLabel,
    cls: "usage-neutral",
    title: t("sessionHudContextUsageTooltipUnknownLimit").replace("{used}", usedLabel),
  };
}

const BELL_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>`;
const FOCUS_UNAVAILABLE_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l16 16"/><path d="M9.5 5h5"/><path d="M7 9h10"/><path d="M5 14h9"/><path d="M12 19h5"/></svg>`;
const FOLDER_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h6l2 2h10v9H3z"/><path d="M3 7V5h6l2 2"/></svg>`;
const PIN_SVG_FILLED = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 4l6 6-4 1-3 3 1 5-2 1-4-4-5 5-1-1 5-5-4-4 1-2 5 1 3-3 1-4z"/></svg>`;
const PIN_SVG_OUTLINE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M14 4l6 6-4 1-3 3 1 5-2 1-4-4-5 5-1-1 5-5-4-4 1-2 5 1 3-3 1-4z"/></svg>`;

function updateUnread(sessions) {
  const now = Date.now();
  const currentIds = new Set(sessions.map((s) => s.id));
  for (const id of unreadSessions) {
    if (!currentIds.has(id)) unreadSessions.delete(id);
  }
  for (const session of sessions) {
    const prev = prevBadges.get(session.id);
    const curr = session.badge;
    if (curr !== "done") {
      unreadSessions.delete(session.id);
    } else if (prev !== undefined && prev !== "done") {
      unreadSessions.add(session.id);
    } else if (prev === undefined) {
      const updatedAt = Number(session.updatedAt);
      if (Number.isFinite(updatedAt) && now - updatedAt <= RECENT_DONE_UNREAD_MS) {
        unreadSessions.add(session.id);
      }
    }
    prevBadges.set(session.id, curr);
  }
  for (const id of prevBadges.keys()) {
    if (!currentIds.has(id)) prevBadges.delete(id);
  }
}

function splitHudLayout(sessions) {
  const maxRows = snapshot.hudShowStateLabels === false
    ? HUD_MAX_EXPANDED_ROWS
    : HUD_MAX_EXPANDED_ROWS_LABELS;
  const expanded = sessions.slice(0, maxRows);
  const folded = sessions.slice(maxRows);
  return { expanded, folded };
}

function focusUnavailableTooltip(session) {
  return t(focusUnavailableReasonKey(session));
}

function showSessionFeedback(sessionId, message) {
  if (sessionActionFeedbackTimer) clearTimeout(sessionActionFeedbackTimer);
  sessionActionFeedback = {
    sessionId,
    message,
    expiresAt: Date.now() + SESSION_ACTION_FEEDBACK_MS,
  };
  render();
  sessionActionFeedbackTimer = setTimeout(() => {
    sessionActionFeedbackTimer = null;
    sessionActionFeedback = null;
    render();
  }, SESSION_ACTION_FEEDBACK_MS);
}

function sessionFeedbackText(sessionId, now) {
  if (!sessionActionFeedback || sessionActionFeedback.sessionId !== sessionId) return "";
  return sessionActionFeedback.expiresAt > now ? sessionActionFeedback.message : "";
}

function openFolderFailureText(result) {
  if (result && result.status === "error" && result.message) {
    return t("sessionOpenFolderFailed").replace("{reason}", result.message);
  }
  return t("sessionOpenFolderUnavailable");
}

function createRowForSession(session, now) {
  const row = document.createElement("div");
  row.className = "row";
  const canFocus = session.canFocus === true;
  const feedbackText = sessionFeedbackText(session.id, now);
  if (!canFocus) {
    row.classList.add("row-unfocusable");
    row.title = focusUnavailableTooltip(session);
  }

  const left = document.createElement("div");
  left.className = "left";

  const dot = document.createElement("span");
  dot.className = `dot dot-${session.badge || "idle"}`;
  left.appendChild(dot);

  if (session.iconUrl) {
    const img = document.createElement("img");
    img.className = "agent-icon";
    img.alt = "";
    img.src = session.iconUrl;
    left.appendChild(img);
  }

  // Source marker for non-local sessions (compact emoji indicator)
  if (session.sourceType && session.sourceType !== "local") {
    const sourceMarker = document.createElement("span");
    sourceMarker.className = `hud-source hud-source-${session.sourceType}`;
    sourceMarker.title = session.sourceDisplayLabel || session.sourceLabel || "";
    sourceMarker.textContent = session.sourceType === "wsl" ? "🐧" : "🔗";
    left.appendChild(sourceMarker);
  }

  const title = document.createElement("span");
  const fullTitle = titleFor(session);
  const shortTitle = shortenHudTitle(fullTitle);
  title.className = feedbackText ? "title session-inline-feedback" : "title";
  title.textContent = feedbackText || shortTitle;
  if (feedbackText) {
    title.title = feedbackText;
    title.setAttribute("aria-live", "polite");
  } else if (shortTitle && shortTitle !== fullTitle) {
    title.title = fullTitle;
  }
  left.appendChild(title);

  const showElapsed = snapshot.hudShowElapsed !== false;
  const right = document.createElement("span");
  right.className = "right";
  let hasRightContent = false;

  if (!feedbackText && session.badge === "done" && unreadSessions.has(session.id)) {
    const bell = document.createElement("span");
    bell.className = "completion-bell unread-bell";
    bell.innerHTML = BELL_SVG;
    right.appendChild(bell);
    hasRightContent = true;

  }

  if (!canFocus) {
    if (!feedbackText) {
      const marker = document.createElement("span");
      marker.className = "focus-unavailable";
      marker.innerHTML = FOCUS_UNAVAILABLE_SVG;
      marker.title = focusUnavailableTooltip(session);
      marker.setAttribute("aria-label", focusUnavailableTooltip(session));
      right.appendChild(marker);
      hasRightContent = true;
    }

    if (canOfferLocalFolder(session)) {
      const openFolder = document.createElement("button");
      openFolder.type = "button";
      openFolder.className = "open-folder-button";
      openFolder.innerHTML = FOLDER_SVG;
      openFolder.title = t("dashboardOpenFolder");
      openFolder.setAttribute("aria-label", t("dashboardOpenFolder"));
      openFolder.disabled = pendingFolderSessions.has(session.id);
      openFolder.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (pendingFolderSessions.has(session.id)) return;
        pendingFolderSessions.add(session.id);
        openFolder.disabled = true;
        render();
        let feedbackMessage = "";
        try {
          const result = await window.sessionHudAPI.openSessionFolder(session.id);
          if (!result || result.status !== "ok") {
            feedbackMessage = openFolderFailureText(result);
          }
        } catch (err) {
          feedbackMessage = t("sessionOpenFolderFailed")
            .replace("{reason}", err && err.message ? err.message : String(err));
          console.warn("open session folder threw:", err);
        }
        pendingFolderSessions.delete(session.id);
        if (feedbackMessage) showSessionFeedback(session.id, feedbackMessage);
        else render();
      });
      right.appendChild(openFolder);
      hasRightContent = true;
    }
  }

  const chipInfo = feedbackText ? null : stateChipInfo(session);
  if (chipInfo) {
    const chip = document.createElement("span");
    chip.className = `state-chip ${chipInfo.cls}`;
    chip.textContent = chipInfo.label;
    right.appendChild(chip);
    hasRightContent = true;
  }

  const usageInfo = feedbackText ? null : usageChipInfo(session);
  if (usageInfo && usageInfo.label) {
    const chip = document.createElement("span");
    chip.className = `usage-chip ${usageInfo.cls}`;
    chip.textContent = usageInfo.label;
    chip.title = usageInfo.title;
    right.appendChild(chip);
    hasRightContent = true;
  }

  if (showElapsed && !feedbackText) {
    const updatedAt = Number(session.updatedAt) || now;
    const elapsed = document.createElement("span");
    elapsed.className = "elapsed";
    elapsed.dataset.updatedAt = String(updatedAt);
    elapsed.textContent = formatElapsed(now - updatedAt);
    right.appendChild(elapsed);
    hasRightContent = true;
  }

  row.appendChild(left);
  if (hasRightContent) row.appendChild(right);

  row.addEventListener("click", () => {
    unreadSessions.delete(session.id);
    if (canFocus) {
      render();
      window.sessionHudAPI.focusSession(session.id);
    } else {
      showSessionFeedback(session.id, focusUnavailableTooltip(session));
    }
    // Fire-and-forget: the row click's primary intent is focus / unread
    // dismissal. ack failure shouldn't block the UI — the next snapshot
    // will reconcile the lifecycle flag.
    if (window.sessionHudAPI && typeof window.sessionHudAPI.ackCompletion === "function") {
      Promise.resolve(window.sessionHudAPI.ackCompletion(session.id)).catch((err) => {
        console.warn("ack completion threw:", err);
      });
    }
  });

  return row;
}

function createFoldedRow(count) {
  const row = document.createElement("div");
  row.className = "row row-folded";

  const left = document.createElement("div");
  left.className = "left";

  const dot = document.createElement("span");
  dot.className = "dot dot-idle";
  left.appendChild(dot);

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t("sessionHudOtherActive").replace("{n}", count);
  left.appendChild(title);

  row.appendChild(left);

  row.addEventListener("click", () => {
    window.sessionHudAPI.openDashboard();
  });

  return row;
}

function createPinButton(pinned) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = pinned ? "pin-btn pinned" : "pin-btn";
  btn.innerHTML = pinned ? PIN_SVG_FILLED : PIN_SVG_OUTLINE;
  const tipKey = pinned ? "sessionHudUnpinTooltip" : "sessionHudPinTooltip";
  btn.title = t(tipKey);
  btn.setAttribute("aria-label", t(tipKey));
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    window.sessionHudAPI.setPinned(!pinned);
  });
  return btn;
}

// ── Account-quota strip ──
// The maintainer's #370 direction: pet-attached, on-demand quota indicators,
// with the Dashboard owning the detailed view. One row per source (local +
// each remote host): a soft pill per provider (AG/CC/CX are product names,
// not translated) holding two ring gauges (5h / 7d) with the used% in the
// center, ring colored by severity. Expired buckets are dropped (wall-clock
// window reset — see src/state-account-quota.js) and a quiet source gets a
// muted age line under its name instead of posing as live.
const HUD_QUOTA_STALE_AFTER_MS = 5 * 60 * 1000;
const HUD_QUOTA_PROVIDERS = [
  { key: "antigravityQuota", label: "AG", fiveHour: "geminiFiveHour", weekly: "geminiWeekly" },
  { key: "claudeQuota", label: "CC", fiveHour: "claudeFiveHour", weekly: "claudeWeekly" },
  { key: "codexQuota", label: "CX", fiveHour: "codexFiveHour", weekly: "codexWeekly" },
];
const QUOTA_DONUT_SIZE = 36;
const QUOTA_DONUT_STROKE = 4.5;
const SVG_NS = "http://www.w3.org/2000/svg";

function liveQuotaBucket(group, field, now) {
  const bucket = group && group[field];
  if (!bucket || typeof bucket !== "object") return null;
  // Window reset on wall clock: the pre-reset number would lie high, but a
  // vanished gauge reads as broken — show a dimmed 0 ("reset, nothing
  // reported since") until the next live report replaces it.
  if (bucket.expired === true || (Number.isFinite(bucket.resetAt) && bucket.resetAt <= now)) {
    return { usedPercent: 0, expired: true };
  }
  return bucket;
}

function quotaSeverityClass(percent) {
  if (percent > 85) return "sev-hot";
  if (percent >= 60) return "sev-warn";
  return "sev-ok";
}

function createQuotaDonut(bucket, windowCap) {
  const percent = Math.max(0, Math.min(100, Number(bucket.usedPercent) || 0));
  const expired = bucket.expired === true;
  const wrap = document.createElement("div");
  wrap.className = expired ? "quota-donut-wrap quota-donut-reset" : "quota-donut-wrap";
  wrap.title = expired ? `${windowCap} · reset` : `${windowCap} · ${percent}%`;

  const size = QUOTA_DONUT_SIZE;
  const half = size / 2;
  const radius = half - QUOTA_DONUT_STROKE / 2 - 0.5;
  const circumference = 2 * Math.PI * radius;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "quota-donut");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("class", "track");
  track.setAttribute("cx", String(half));
  track.setAttribute("cy", String(half));
  track.setAttribute("r", String(radius));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke-width", String(QUOTA_DONUT_STROKE));
  svg.appendChild(track);

  const arc = document.createElementNS(SVG_NS, "circle");
  arc.setAttribute("class", `arc ${expired ? "sev-reset" : quotaSeverityClass(percent)}`);
  arc.setAttribute("cx", String(half));
  arc.setAttribute("cy", String(half));
  arc.setAttribute("r", String(radius));
  arc.setAttribute("stroke-width", String(QUOTA_DONUT_STROKE));
  // A hairline of arc even at 0% reads as "alive and unused" rather than
  // "broken gauge"; full circle at 100%.
  const filled = Math.max(circumference * (percent / 100), percent > 0 ? 1.2 : 0.6);
  arc.setAttribute("stroke-dasharray", `${filled} ${circumference}`);
  svg.appendChild(arc);

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(half));
  text.setAttribute("y", String(half));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.textContent = String(Math.round(percent));
  svg.appendChild(text);

  wrap.appendChild(svg);
  const cap = document.createElement("div");
  cap.className = "quota-donut-cap";
  cap.textContent = windowCap;
  wrap.appendChild(cap);
  return wrap;
}

// Last confirmation from the reporter (lastSeenAt), falling back to the
// last value change (updatedAt) for snapshots that predate lastSeenAt.
// Staleness must follow confirmations, not changes: a reporter confirming
// the same 41% every minute is alive, not stale.
function quotaProviderSeenAt(provider) {
  const lastSeenAt = Number(provider && provider.lastSeenAt);
  if (Number.isFinite(lastSeenAt)) return lastSeenAt;
  const updatedAt = Number(provider && provider.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : null;
}

// Display-state digest of everything time flips WITHOUT a new snapshot:
// bucket expiry and source staleness. The 1s tick recomputes this and
// re-renders on change — otherwise a pinned HUD with no incoming snapshots
// would show a pre-reset high forever and never age its sources.
function computeQuotaDisplayFingerprint(now) {
  if (snapshot.hudShowQuota === false) return "";
  const sources = Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [];
  const parts = [];
  for (const source of sources) {
    for (const def of HUD_QUOTA_PROVIDERS) {
      const provider = source[def.key];
      const group = provider && provider.group;
      if (!group) continue;
      for (const field of [def.fiveHour, def.weekly]) {
        const bucket = liveQuotaBucket(group, field, now);
        if (bucket) parts.push(`${source.host || ""}:${field}:${bucket.expired === true ? 1 : 0}`);
      }
      const seenAt = quotaProviderSeenAt(provider);
      parts.push(`${source.host || ""}:${def.key}:${seenAt !== null && now - seenAt > HUD_QUOTA_STALE_AFTER_MS ? 1 : 0}`);
    }
  }
  return parts.join("|");
}

function buildQuotaStrip(now) {
  if (snapshot.hudShowQuota === false) return null;
  const sources = Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [];
  if (!sources.length) return null;

  const strip = document.createElement("div");
  strip.className = "quota-strip";
  const multiSource = sources.length > 1;
  let hasAny = false;

  for (const source of sources) {
    const pills = document.createElement("div");
    pills.className = "quota-pills";
    let oldestSeenAt = null;

    for (const def of HUD_QUOTA_PROVIDERS) {
      const provider = source[def.key];
      const group = provider && provider.group;
      if (!group) continue;
      const fiveHour = liveQuotaBucket(group, def.fiveHour, now);
      const weekly = liveQuotaBucket(group, def.weekly, now);
      if (!fiveHour && !weekly) continue;

      const pill = document.createElement("div");
      pill.className = "quota-pill";
      // Providers age independently under one source (Claude confirmed just
      // now, Codex quiet since yesterday) — a stale provider carries its own
      // age in the tooltip so the row-level age (the OLDEST provider) does
      // not tar the fresh gauges.
      const seenAt = quotaProviderSeenAt(provider);
      const providerStale = seenAt !== null && now - seenAt > HUD_QUOTA_STALE_AFTER_MS;
      pill.title = providerStale ? `${def.label} · ${formatElapsed(now - seenAt)}` : def.label;
      const iconUrl = snapshot.quotaAgentIcons && snapshot.quotaAgentIcons[def.key];
      if (iconUrl) {
        const icon = document.createElement("img");
        icon.className = "quota-pill-icon";
        icon.src = iconUrl;
        icon.alt = def.label;
        pill.appendChild(icon);
      } else {
        const label = document.createElement("span");
        label.className = "quota-pill-label";
        label.textContent = def.label;
        pill.appendChild(label);
      }
      if (fiveHour) pill.appendChild(createQuotaDonut(fiveHour, "5h"));
      if (weekly) pill.appendChild(createQuotaDonut(weekly, "7d"));
      pills.appendChild(pill);

      if (seenAt !== null) {
        oldestSeenAt = oldestSeenAt === null ? seenAt : Math.min(oldestSeenAt, seenAt);
      }
    }
    if (!pills.childElementCount) continue;
    hasAny = true;

    const row = document.createElement("div");
    row.className = "quota-strip-row";
    const isStale = oldestSeenAt !== null && now - oldestSeenAt > HUD_QUOTA_STALE_AFTER_MS;
    if (multiSource || source.host || isStale) {
      const sourceEl = document.createElement("div");
      sourceEl.className = "quota-strip-source";
      // A lone local source going stale shows only the compact age badge:
      // the window was sized without a label column (see session-hud.js
      // computeQuotaStripMinWidth), and "This machine" adds nothing when
      // there is exactly one unlabeled source.
      if (multiSource || source.host) {
        const host = document.createElement("span");
        host.className = "quota-strip-host";
        host.textContent = source.host || t("dashboardQuotaSourceLocal");
        sourceEl.appendChild(host);
      }
      if (isStale) {
        const stale = document.createElement("span");
        stale.className = "quota-strip-stale";
        stale.dataset.seenAt = String(oldestSeenAt);
        stale.textContent = formatElapsed(now - oldestSeenAt);
        sourceEl.appendChild(stale);
      }
      row.appendChild(sourceEl);
    }
    row.appendChild(pills);
    strip.appendChild(row);
  }

  return hasAny ? strip : null;
}

let lastQuotaFingerprint = "";

function render() {
  const sessions = orderedHudSessions(snapshot);
  const currentIds = new Set(sessions.map((session) => session.id));
  for (const sessionId of pendingFolderSessions) {
    if (!currentIds.has(sessionId)) pendingFolderSessions.delete(sessionId);
  }
  if (sessionActionFeedback && !currentIds.has(sessionActionFeedback.sessionId)) {
    if (sessionActionFeedbackTimer) clearTimeout(sessionActionFeedbackTimer);
    sessionActionFeedbackTimer = null;
    sessionActionFeedback = null;
  }
  updateUnread(sessions);
  hudEl.replaceChildren();
  hudEl.classList.add("has-pin");

  const now = Date.now();
  lastQuotaFingerprint = computeQuotaDisplayFingerprint(now);
  const quotaStrip = buildQuotaStrip(now);
  if (quotaStrip) hudEl.appendChild(quotaStrip);
  if (!sessions.length) {
    // Quota-only card ("check the quota before starting work"): the strip
    // stands alone, and the pin still works so it can be kept on screen.
    if (quotaStrip) hudEl.appendChild(createPinButton(snapshot.hudPinned === true));
    return;
  }
  const { expanded, folded } = splitHudLayout(sessions);

  for (const session of expanded) {
    hudEl.appendChild(createRowForSession(session, now));
  }
  if (folded.length > 0) {
    hudEl.appendChild(createFoldedRow(folded.length));
  }

  hudEl.appendChild(createPinButton(snapshot.hudPinned === true));
}

function updateElapsedLabels() {
  const now = Date.now();
  // Quota expiry / staleness flip on wall clock, not on snapshots — a
  // pinned HUD receives no snapshot while nothing changes, so the tick owns
  // these transitions (full re-render on fingerprint change; cheap: the
  // digest is a few string ops over a handful of buckets).
  const quotaFingerprint = computeQuotaDisplayFingerprint(now);
  if (quotaFingerprint !== lastQuotaFingerprint) {
    render();
    return;
  }
  for (const elapsed of document.querySelectorAll(".elapsed[data-updated-at]")) {
    const updatedAt = Number(elapsed.dataset.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    elapsed.textContent = formatElapsed(now - updatedAt);
  }
  for (const stale of document.querySelectorAll(".quota-strip-stale[data-seen-at]")) {
    const seenAt = Number(stale.dataset.seenAt);
    if (!Number.isFinite(seenAt)) continue;
    stale.textContent = formatElapsed(now - seenAt);
  }
}

async function init() {
  window.sessionHudAPI.onLangChange((payload) => {
    i18nPayload = payload || i18nPayload;
    render();
  });
  window.sessionHudAPI.onSessionSnapshot((nextSnapshot) => {
    snapshot = nextSnapshot || snapshot;
    render();
  });

  i18nPayload = await window.sessionHudAPI.getI18n() || i18nPayload;
  render();
  setInterval(updateElapsedLabels, 1000);
}

init().catch((err) => {
  hudEl.textContent = err && err.message ? err.message : String(err);
});
