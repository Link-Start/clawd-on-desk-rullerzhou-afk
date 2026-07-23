"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rendererSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "quota-ring-renderer.js"),
  "utf8"
);

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.attributes = {};
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.title = "";
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  setAttributeNS(_namespace, name, value) {
    this.setAttribute(name, value);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener() {}
}

function loadRenderer() {
  const cluster = new FakeElement("div");
  const context = {
    document: {
      getElementById: () => cluster,
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (_namespace, tag) => new FakeElement(tag),
    },
    window: {
      quotaRingAPI: {
        onLangChange() {},
        onSnapshot() {},
        getI18n: async () => null,
        openDashboard() {},
      },
    },
    setInterval() {},
    Date,
    Math,
    Promise,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(rendererSource, context);
  vm.runInContext(`
    payload = {
      accountQuota: [],
      quotaAgentIcons: {},
      side: "left",
      translations: {
        dashboardQuotaGroupGemini: "Gemini",
        dashboardQuotaGroupThirdParty: "Claude/GPT",
        dashboardQuotaSourceLocal: "Local",
        quotaRingReset: "reset",
        quotaRingUsedWord: "used",
        dashboardQuotaResetIn: "resets in {time}",
        dashboardQuotaResetHoursMinutes: "{h}h {m}m",
        dashboardQuotaResetMinutes: "{m}m",
        dashboardQuotaAsOf: "as of {time} ago"
      }
    };
  `, context);
  return context;
}

function modelFor(context, source, providerIndex, now, multiSource = false) {
  context.__source = source;
  context.__now = now;
  context.__multiSource = multiSource;
  return vm.runInContext(
    "buildCoinModel(__source, RING_PROVIDERS[" + providerIndex + "], __now, __multiSource)",
    context
  );
}

describe("quota ring renderer model", () => {
  it("compresses all four Antigravity buckets to the most constrained rolling and weekly rings", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const future = now + 3_600_000;
    const model = modelFor(context, {
      antigravityQuota: {
        group: {
          geminiFiveHour: { usedPercent: 30, resetAt: future, windowMinutes: 300 },
          geminiWeekly: { usedPercent: 40, resetAt: future, windowMinutes: 10080 },
          thirdPartyFiveHour: { usedPercent: 72, resetAt: future, windowMinutes: 300 },
          thirdPartyWeekly: { usedPercent: 91, resetAt: future, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 0, now);

    assert.strictEqual(model.windows.length, 2);
    assert.strictEqual(model.windows[0].field, "thirdPartyFiveHour");
    assert.strictEqual(model.windows[0].label, "C/G·5h");
    assert.strictEqual(model.windows[1].field, "thirdPartyWeekly");
    assert.strictEqual(model.windows[1].detailLabel, "Claude/GPT · 7d");
    assert.strictEqual(model.binding.field, "thirdPartyWeekly");
  });

  it("renders third-party-only Antigravity quota instead of dropping the provider", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      antigravityQuota: {
        group: {
          thirdPartyWeekly: {
            usedPercent: 52,
            resetAt: now + 3_600_000,
            windowMinutes: 10080,
          },
        },
        lastSeenAt: now,
      },
    }, 0, now);

    assert.ok(model);
    assert.strictEqual(model.windows.length, 1);
    assert.strictEqual(model.windows[0].field, "thirdPartyWeekly");
  });

  it("pulses only the binding ring when the inner window is near exhaustion", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      claudeQuota: {
        group: {
          claudeFiveHour: { usedPercent: 20, resetAt: now + 3_600_000, windowMinutes: 300 },
          claudeWeekly: { usedPercent: 90, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 1, now);
    context.__model = model;
    const svg = vm.runInContext("buildCoinSvg(__model)", context);
    const fills = svg.children.filter((child) =>
      typeof child.attributes.class === "string" && child.attributes.class.includes("fill"));

    assert.strictEqual(fills.length, 2);
    assert.doesNotMatch(fills[0].attributes.class, /is-near/);
    assert.match(fills[1].attributes.class, /sev-hot is-near/);
  });

  it("shows a compact source marker when more than one machine contributes quota", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    const model = modelFor(context, {
      host: "remote-build-host",
      codexQuota: {
        group: {
          codexWeekly: { usedPercent: 12, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }, 2, now, true);
    context.__model = model;
    const row = vm.runInContext("buildCoinRow(__model, __now)", context);
    const readout = row.children[0];
    const source = readout.children.find((child) => child.className === "source");

    assert.ok(source);
    assert.strictEqual(source.textContent, "remote-build-host");
    assert.strictEqual(model.host, "remote-build-host");
  });

  it("changes its fingerprint when a non-binding window resets or stale age advances", () => {
    const context = loadRenderer();
    const now = 1_000_000;
    context.__accountQuota = [{
      claudeQuota: {
        group: {
          claudeFiveHour: { usedPercent: 20, resetAt: now + 1_000, windowMinutes: 300 },
          claudeWeekly: { usedPercent: 80, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: now,
      },
    }];
    vm.runInContext("payload.accountQuota = __accountQuota", context);
    const beforeReset = vm.runInContext("fingerprint(1000000)", context);
    const afterReset = vm.runInContext("fingerprint(1002000)", context);
    assert.notStrictEqual(beforeReset, afterReset);

    context.__accountQuota = [{
      codexQuota: {
        group: {
          codexWeekly: { usedPercent: 10, resetAt: now + 3_600_000, windowMinutes: 10080 },
        },
        lastSeenAt: 1,
      },
    }];
    vm.runInContext("payload.accountQuota = __accountQuota", context);
    const staleMinuteA = vm.runInContext("fingerprint(1000000)", context);
    const staleMinuteB = vm.runInContext("fingerprint(1060000)", context);
    assert.notStrictEqual(staleMinuteA, staleMinuteB);
  });
});
