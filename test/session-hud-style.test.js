const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sessionHudHtml = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud.html"), "utf8");
const sessionHudRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8");

describe("session HUD account-quota strip", () => {
  it("renders the per-source quota strip above session rows, gated by hudShowQuota", () => {
    // Maintainer's #370 direction: pet-attached on-demand indicators; the
    // Dashboard owns the detailed view.
    assert.match(sessionHudRenderer, /buildQuotaStrip\(now\)/);
    assert.match(sessionHudRenderer, /snapshot\.hudShowQuota === false/);
    assert.match(sessionHudRenderer, /snapshot\.accountQuota/);
    assert.match(sessionHudHtml, /\.quota-strip\s*\{/);
  });

  it("draws ring gauges per provider window with severity coloring", () => {
    assert.match(sessionHudRenderer, /createQuotaDonut/);
    assert.match(sessionHudRenderer, /stroke-dasharray/);
    assert.match(sessionHudRenderer, /quotaSeverityClass/);
    assert.match(sessionHudRenderer, /sev-hot/);
    assert.match(sessionHudHtml, /\.quota-donut \.arc\.sev-ok/);
    assert.match(sessionHudHtml, /\.quota-donut \.arc\.sev-warn/);
    assert.match(sessionHudHtml, /\.quota-donut \.arc\.sev-hot/);
    assert.match(sessionHudHtml, /\.quota-pill\s*\{/);
  });

  it("dims reset windows and labels quiet sources instead of posing as live", () => {
    assert.match(sessionHudRenderer, /liveQuotaBucket/);
    assert.match(sessionHudRenderer, /bucket\.resetAt <= now/);
    // Expired = dimmed 0-ring, never the pre-reset high, never a vanished gauge.
    assert.match(sessionHudRenderer, /usedPercent: 0, expired: true/);
    assert.match(sessionHudRenderer, /sev-reset/);
    assert.match(sessionHudHtml, /\.quota-donut-reset/);
    assert.match(sessionHudRenderer, /HUD_QUOTA_STALE_AFTER_MS/);
    assert.match(sessionHudRenderer, /quota-strip-stale/);
  });

  it("labels provider pills with agent icons, falling back to text", () => {
    assert.match(sessionHudRenderer, /quotaAgentIcons/);
    assert.match(sessionHudRenderer, /quota-pill-icon/);
    assert.match(sessionHudRenderer, /quota-pill-label/);
    assert.match(sessionHudHtml, /\.quota-pill-icon/);
  });

  it("hides the source label for a single local source (compact default)", () => {
    assert.match(sessionHudRenderer, /multiSource \|\| source\.host/);
    assert.match(sessionHudRenderer, /dashboardQuotaSourceLocal/);
  });
});

describe("session HUD visual shell", () => {
  it("adds asymmetric body padding so the shadow has more room below than above", () => {
    assert.match(sessionHudHtml, /body\s*\{[\s\S]*padding:\s*2px 3px 8px;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*width:\s*100%;[\s\S]*height:\s*100%;[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\s*\{[\s\S]*width:\s*240px;[\s\S]*\}/);
  });

  it("keeps the rounded card while switching to a bottom-biased shadow", () => {
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*border-radius:\s*8px;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*box-shadow:\s*0 8px 18px -12px var\(--shadow\),\s*0 2px 4px rgba\(0,\s*0,\s*0,\s*0\.10\);[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\s*\{[\s\S]*box-shadow:\s*0 4px 14px var\(--shadow\);[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*background:\s*var\(--hud-bg\);[\s\S]*\}/);
  });

  it("reserves row-level space for the auto-hide pin button", () => {
    assert.match(sessionHudHtml, /\.hud\.has-pin\s+\.row\s*\{[\s\S]*padding-right:\s*28px;[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\.has-pin\s+\.row\s+\.right\s*\{[\s\S]*padding-right:/);
  });

  it("marks non-focusable HUD sessions without attempting terminal focus", () => {
    assert.match(sessionHudHtml, /\.row-unfocusable\s*\{[\s\S]*cursor:\s*default;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.focus-unavailable\s*\{[\s\S]*width:\s*13px;[\s\S]*\}/);
    assert.match(sessionHudRenderer, /session\.canFocus\s*===\s*true/);
    assert.match(sessionHudRenderer, /row\.classList\.add\("row-unfocusable"\)/);
    assert.match(sessionHudRenderer, /if \(canFocus\) window\.sessionHudAPI\.focusSession\(session\.id\);/);
  });

  it("renders state labels without replacing unread completed-session bells", () => {
    assert.match(sessionHudHtml, /\.state-chip\s*\{/);
    assert.match(sessionHudHtml, /\.chip-working\s*\{/);
    assert.match(sessionHudHtml, /\.chip-worktree\s*\{/);
    assert.match(sessionHudHtml, /\.completion-bell\s*\{/);
    assert.match(sessionHudRenderer, /const STATE_CHIP_MAP\s*=/);
    assert.match(sessionHudRenderer, /const EVENT_CHIP_MAP\s*=/);
    assert.match(sessionHudRenderer, /PermissionRequest:\s*\{ key: "sessionNotification"/);
    assert.match(sessionHudRenderer, /PreCompact:\s*\{ key: "sessionSweeping"/);
    assert.match(sessionHudRenderer, /WorktreeCreate:\s*\{ key: "sessionWorktree"/);
    assert.match(sessionHudRenderer, /session\.badge === "done" && unreadSessions\.has\(session\.id\)/);
    assert.match(sessionHudRenderer, /bell\.className = "completion-bell unread-bell"/);
    assert.match(sessionHudRenderer, /RECENT_DONE_UNREAD_MS\s*=\s*60 \* 1000/);
    assert.match(sessionHudRenderer, /prev === undefined[\s\S]{0,180}unreadSessions\.add\(session\.id\)/);
    assert.doesNotMatch(sessionHudRenderer, /sessionBadgeDone[\s\S]{0,80}chip-done/);
    assert.doesNotMatch(sessionHudRenderer, /sessionCarrying/);
  });

  it("uses a compact HUD-only title without mutating the full session title", () => {
    assert.match(sessionHudRenderer, /HUD_TITLE_MAX_UNITS\s*=\s*15/);
    assert.match(sessionHudRenderer, /function shortenHudTitle\(value\)/);
    assert.match(sessionHudRenderer, /title\.textContent = shortTitle/);
    assert.match(sessionHudRenderer, /title\.title = fullTitle/);
  });

  it("updates elapsed labels without rebuilding animated rows every second", () => {
    assert.match(sessionHudRenderer, /function updateElapsedLabels\(\)/);
    assert.match(sessionHudRenderer, /elapsed\.className = "elapsed"/);
    assert.match(sessionHudRenderer, /setInterval\(updateElapsedLabels, 1000\)/);
    assert.doesNotMatch(sessionHudRenderer, /setInterval\(render, 1000\)/);
  });

  it("keeps context usage chips visible before truncating elapsed text", () => {
    // Flexbox quirk regression guard: overflow:hidden gives a flex item an
    // AUTOMATIC minimum size of 0, so without an explicit min-content floor
    // .right shrinks below its chips under squeeze and its own overflow
    // clipping cuts them mid-glyph. The elapsed span keeps min-width: 0 so it
    // contributes nothing to that floor and truncates first.
    assert.match(sessionHudHtml, /\.right\s*\{[\s\S]*?flex:\s*0 1 auto;[\s\S]*?max-width:\s*58%;[\s\S]*?min-width:\s*min-content;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/);
    const rightBlock = sessionHudHtml.match(/\.right\s*\{[\s\S]*?\}/);
    assert.ok(rightBlock, "session-hud.html should define a .right rule");
    assert.doesNotMatch(rightBlock[0], /min-width:\s*0\b/, ".right must not zero its width floor");
    assert.match(sessionHudHtml, /\.elapsed\s*\{[\s\S]*min-width:\s*0;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.usage-chip\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*white-space:\s*nowrap;[\s\S]*\}/);
  });

  it("honors reduced motion for HUD animations", () => {
    assert.match(sessionHudHtml, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.dot-running\s*\{[\s\S]*animation:\s*none;/);
    assert.match(sessionHudHtml, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.unread-bell svg\s*\{[\s\S]*animation:\s*none;/);
  });
});
