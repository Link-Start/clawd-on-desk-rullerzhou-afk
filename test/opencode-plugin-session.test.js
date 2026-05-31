const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function loadSessionIdModule() {
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-plugin", "session-ids.mjs");
  return import(pathToFileURL(modulePath).href);
}

async function loadPluginModule() {
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-plugin", "index.mjs");
  return import(pathToFileURL(modulePath).href);
}

describe("opencode plugin session ids", () => {
  it("namespaces raw opencode session ids before sending them to Clawd", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.normalizeOpencodeSessionId("ses_123"), "opencode:ses_123");
    assert.strictEqual(mod.normalizeOpencodeSessionId("  ses_123  "), "opencode:ses_123");
    assert.strictEqual(mod.normalizeOpencodeSessionId("opencode:ses_123"), "opencode:ses_123");
    assert.strictEqual(mod.normalizeOpencodeSessionId(""), null);
  });

  it("falls back to the latest opencode session instead of bare default", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.resolveOpencodeSessionId(null, "ses_latest"), "opencode:ses_latest");
    assert.strictEqual(mod.resolveOpencodeSessionId(null, "opencode:ses_latest"), "opencode:ses_latest");
    assert.strictEqual(mod.resolveOpencodeSessionId(null, null), "opencode:default");
  });

  it("extracts event.properties.sessionID and top-level event.sessionID", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.getEventSessionId({ properties: { sessionID: " ses_abc " } }), "ses_abc");
    assert.strictEqual(mod.getEventSessionId({ sessionID: " top_level " }), "top_level");
    assert.strictEqual(mod.getEventSessionId({ properties: { sessionID: "" } }), null);
    assert.strictEqual(mod.getEventSessionId({ properties: {} }), null);
    assert.strictEqual(mod.getEventSessionId(null), null);
  });

  it("drops SessionEnd mappings that have no raw opencode session id", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(
      mod.shouldDropMappedEventWithoutSessionId(
        { type: "session.deleted", properties: {} },
        { state: "sleeping", event: "SessionEnd" }
      ),
      true
    );
    assert.strictEqual(
      mod.shouldDropMappedEventWithoutSessionId(
        { type: "session.deleted", properties: { sessionID: "ses_abc" } },
        { state: "sleeping", event: "SessionEnd" }
      ),
      false
    );
    assert.strictEqual(
      mod.shouldDropMappedEventWithoutSessionId(
        { type: "session.idle", properties: {} },
        { state: "attention", event: "Stop" }
      ),
      false
    );
  });

  it("wires session start and end events to the same namespaced Clawd session id", async () => {
    const mod = await loadPluginModule();
    const start = { type: "session.created", properties: { sessionID: "ses_same" } };
    const end = { type: "session.deleted", properties: { sessionID: "ses_same" } };

    const startMapped = mod.__test.translateEvent(start);
    const endMapped = mod.__test.translateEvent(end);
    const startBody = mod.__test.buildStateBody(startMapped.state, startMapped.event, "ses_same");
    const endBody = mod.__test.buildStateBody(endMapped.state, endMapped.event, "ses_same");

    assert.strictEqual(startBody.session_id, "opencode:ses_same");
    assert.strictEqual(endBody.session_id, "opencode:ses_same");
    assert.strictEqual(startBody.event, "SessionStart");
    assert.strictEqual(endBody.event, "SessionEnd");
  });
});
