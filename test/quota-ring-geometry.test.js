const { describe, it } = require("node:test");
const assert = require("node:assert");

const ringGeom = require("../src/quota-ring-geometry");
const {
  countQuotaCoins,
  formatWindowLabel,
  quotaSeverity,
  ringClusterContentSize,
  resolveRingSide,
  computeQuotaRingBounds,
  constants,
} = ringGeom;

const future = Date.now() + 3600000;

function bucket(pct) {
  return { usedPercent: pct, resetAt: future };
}

describe("quota ring — coin counting", () => {
  it("counts one coin per (source, provider) with a drawable bucket", () => {
    const snapshot = {
      accountQuota: [
        {
          host: null,
          claudeQuota: { group: { claudeFiveHour: bucket(41), claudeWeekly: bucket(20) }, updatedAt: 1 },
          codexQuota: { group: { codexFiveHour: bucket(72) }, updatedAt: 1 },
        },
        { host: "pi", claudeQuota: { group: { claudeWeekly: bucket(9) }, updatedAt: 1 } },
      ],
    };
    // 2 providers on local + 1 on the remote = 3 coins (a provider with two
    // windows is still ONE coin — the two windows become concentric rings).
    assert.strictEqual(countQuotaCoins(snapshot, true), 3);
  });

  it("still counts a source whose only window has expired (dimmed reset coin)", () => {
    const snapshot = {
      accountQuota: [
        { host: "x", codexQuota: { group: { codexFiveHour: { usedPercent: 9, resetAt: Date.now() - 1000, expired: true } }, updatedAt: 1 } },
      ],
    };
    assert.strictEqual(countQuotaCoins(snapshot, true), 1);
  });

  it("returns 0 when quota is disabled, empty, or only carries non-drawable buckets", () => {
    const drawable = { accountQuota: [{ claudeQuota: { group: { claudeWeekly: bucket(10) }, updatedAt: 1 } }] };
    assert.strictEqual(countQuotaCoins(drawable, false), 0);
    assert.strictEqual(countQuotaCoins({ accountQuota: [] }, true), 0);
    assert.strictEqual(countQuotaCoins({}, true), 0);
    // Antigravity source that only reports third-party buckets the ring can't draw.
    const thirdPartyOnly = {
      accountQuota: [{ antigravityQuota: { group: { thirdPartyWeekly: bucket(52) }, updatedAt: 1 } }],
    };
    assert.strictEqual(countQuotaCoins(thirdPartyOnly, true), 0);
  });
});

describe("quota ring — cluster sizing", () => {
  it("grows height with coin count and keeps a fixed content width", () => {
    const one = ringClusterContentSize(1);
    const two = ringClusterContentSize(2);
    assert.strictEqual(one.width, two.width, "width is fixed (coin + readout column)");
    assert.ok(two.height > one.height, "two coins are taller than one");
    assert.strictEqual(two.height - one.height, constants.COIN_SIZE + constants.COIN_GAP);
    assert.strictEqual(one.overflow, 0);
  });

  it("caps visible coins and reports the overflow, adding a row for the +N pill", () => {
    const capped = ringClusterContentSize(constants.RING_MAX_COINS + 2);
    assert.strictEqual(capped.visible, constants.RING_MAX_COINS);
    assert.strictEqual(capped.overflow, 2);
    const exactly = ringClusterContentSize(constants.RING_MAX_COINS);
    assert.ok(capped.height > exactly.height, "the overflow pill adds height");
    assert.strictEqual(exactly.overflow, 0);
  });
});

describe("quota ring — side resolution & edge flip", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };

  it("defaults to the pet's left (clear of the right-entering permission bubble)", () => {
    const side = resolveRingSide({ petLeft: 700, petRight: 850, workArea, clusterWidth: 80 });
    assert.strictEqual(side, "left");
  });

  it("flips to the right when the pet hugs the left edge", () => {
    const side = resolveRingSide({ petLeft: 20, petRight: 170, workArea, clusterWidth: 80 });
    assert.strictEqual(side, "right");
  });

  it("keeps the side with more room when neither side fully fits", () => {
    const narrow = { x: 0, y: 0, width: 200, height: 900 };
    // Pet near the right edge of a narrow work area → left has more room.
    const side = resolveRingSide({ petLeft: 150, petRight: 190, workArea: narrow, clusterWidth: 300 });
    assert.strictEqual(side, "left");
  });
});

describe("quota ring — bounds placement", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  const hitRect = { left: 700, top: 400, right: 850, bottom: 550 };

  it("returns null when there are no coins", () => {
    assert.strictEqual(computeQuotaRingBounds({ hitRect, workArea, coinCount: 0 }), null);
    assert.strictEqual(computeQuotaRingBounds({ hitRect: null, workArea, coinCount: 2 }), null);
  });

  it("places the cluster to the left of the pet, vertically centered on the body", () => {
    const r = computeQuotaRingBounds({ hitRect, workArea, coinCount: 2, scale: 1 });
    assert.strictEqual(r.side, "left");
    // Content sits gap px to the left of the pet body.
    assert.strictEqual(r.contentBounds.x + r.contentBounds.width, hitRect.left - constants.RING_PET_GAP);
    // Vertically centered on the pet body center (475).
    const petCy = (hitRect.top + hitRect.bottom) / 2;
    const ringCy = r.contentBounds.y + r.contentBounds.height / 2;
    assert.ok(Math.abs(ringCy - petCy) <= 1);
    // Outer window bounds wrap the content by the transparent shell.
    assert.strictEqual(r.bounds.x, r.contentBounds.x - constants.RING_SHELL.left);
    assert.ok(r.bounds.width > r.contentBounds.width);
  });

  it("flips to the right of the pet near the left edge and stays on-screen", () => {
    const leftPet = { left: 16, top: 400, right: 150, bottom: 520 };
    const r = computeQuotaRingBounds({ hitRect: leftPet, workArea, coinCount: 2, scale: 1 });
    assert.strictEqual(r.side, "right");
    assert.strictEqual(r.contentBounds.x, leftPet.right + constants.RING_PET_GAP);
    assert.ok(r.contentBounds.x >= workArea.x);
  });

  it("scales the footprint and gaps with textScale", () => {
    const base = computeQuotaRingBounds({ hitRect, workArea, coinCount: 2, scale: 1 });
    const big = computeQuotaRingBounds({ hitRect, workArea, coinCount: 2, scale: 1.5 });
    assert.ok(big.contentBounds.width > base.contentBounds.width);
    assert.ok(big.contentBounds.height > base.contentBounds.height);
  });

  it("clamps a tall cluster inside the work area vertically", () => {
    const shortWa = { x: 0, y: 0, width: 1440, height: 300 };
    const r = computeQuotaRingBounds({ hitRect, workArea: shortWa, coinCount: 4, scale: 1 });
    assert.ok(r.contentBounds.y >= shortWa.y);
    assert.ok(r.contentBounds.y + r.contentBounds.height <= shortWa.y + shortWa.height);
  });
});

describe("quota ring — window labels & severity", () => {
  it("derives labels from windowMinutes, never assuming 5h/7d", () => {
    assert.strictEqual(formatWindowLabel(300, "5h"), "5h");
    assert.strictEqual(formatWindowLabel(60, "x"), "1h");
    assert.strictEqual(formatWindowLabel(10080, "x"), "7d");
    assert.strictEqual(formatWindowLabel(1440, "x"), "1d");
    assert.strictEqual(formatWindowLabel(90, "x"), "90m");
    assert.strictEqual(formatWindowLabel(undefined, "wk"), "wk", "falls back when no minutes");
    assert.strictEqual(formatWindowLabel(0, "wk"), "wk");
  });

  it("maps used percent to severity buckets (hot > 85, warn >= 60, else ok)", () => {
    assert.strictEqual(quotaSeverity(10), "ok");
    assert.strictEqual(quotaSeverity(59), "ok");
    assert.strictEqual(quotaSeverity(60), "warn");
    assert.strictEqual(quotaSeverity(85), "warn");
    assert.strictEqual(quotaSeverity(86), "hot");
    assert.strictEqual(quotaSeverity(100), "hot");
  });
});
