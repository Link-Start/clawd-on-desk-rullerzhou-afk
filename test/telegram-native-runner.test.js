"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createTelegramNativeRunner } = require("../src/telegram-native-runner");
const { EVENTS } = require("../src/telegram-migration-state");
const { createFakeTelegramServer } = require("./fakes/telegram-server");

const VALID_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_jklmnop";

function tokenStore(token = VALID_TOKEN) {
  return {
    async getToken() { return token; },
    async hasToken() { return !!token; },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("sendTestCard defers TEST_FAILED when Telegram sendMessage fails", async () => {
  const server = createFakeTelegramServer();
  const events = [];
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async (event) => { events.push(event); },
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });
  server.enqueueError("sendMessage", { status: 401, description: "Unauthorized" });

  await runner.sendTestCard();
  assert.deepEqual(events, [], "failure is deferred until caller can enter TESTING_NATIVE");

  await delay(5);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENTS.TEST_FAILED);
  assert.equal(events[0].errorClass, "401");
});

test("sendTestCard defers TEST_FAILED when chat id is missing", async () => {
  const events = [];
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: createFakeTelegramServer().transport,
    getDispatch: () => async (event) => { events.push(event); },
    getChatId: () => "",
    getAllowedUserId: () => "777",
  });

  await runner.sendTestCard();
  assert.deepEqual(events, []);
  await delay(5);
  assert.deepEqual(events, [{ type: EVENTS.TEST_FAILED, errorClass: "no_chat" }]);
});

test("native runner sends nonce card and dispatches TEST_SUCCESS for matching callback", async () => {
  const server = createFakeTelegramServer();
  const events = [];
  let runner;
  let releaseFirstPoll;
  let callbackData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    callbackData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    return { ok: true, result: { message_id: 42, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: 777 },
        message: { chat: { id: 123 } },
        data: callbackData,
      },
    }],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 42 });

  runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async (event) => {
      events.push(event);
      await runner.stop();
    },
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  assert.equal(server.calls[0].method, "getUpdates");

  await runner.sendTestCard();
  assert.match(callbackData, /^clawd-test:[a-z0-9]+$/);

  releaseFirstPoll({ ok: true, result: [] });
  await tick();
  await tick();
  await tick();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENTS.TEST_SUCCESS);
  assert.equal(server.calls.some((call) => call.method === "answerCallbackQuery"), true);
  assert.equal(server.calls.some((call) => call.method === "editMessageReplyMarkup"), true);
  assert.equal(runner.isPolling(), false);
});

test("native runner requestApproval resolves allow for matching callback", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let allowData = "";
  let denyData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    assert.match(payload.text, /claude-code requests Bash/);
    assert.match(payload.text, /Summary: Run tests/);
    allowData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    denyData = payload.reply_markup.inline_keyboard[0][1].callback_data;
    return { ok: true, result: { message_id: 99, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: {
        id: "cb-allow",
        from: { id: 777 },
        message: { message_id: 99, chat: { id: 123 } },
        data: allowData,
      },
    }],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 99 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
  });
  await tick();
  assert.match(allowData, /^cp:[a-z0-9]+:a$/);
  assert.match(denyData, /^cp:[a-z0-9]+:d$/);

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.deepEqual(decision, { action: "allow" });
  assert.equal(server.calls.some((call) => call.method === "answerCallbackQuery"), true);
  assert.equal(server.calls.some((call) => call.method === "editMessageReplyMarkup"), true);
  await runner.stop();
});

test("native runner requestApproval renders suggestions and returns suggestion decisions", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let suggestionData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    const keyboard = payload.reply_markup.inline_keyboard;
    assert.deepEqual(keyboard[0].map((button) => button.text), ["Allow once", "Deny"]);
    assert.equal(keyboard[1][0].text, "Always Bash");
    assert.equal(keyboard[2][0].text, "Auto edits");
    assert.match(keyboard[1][0].callback_data, /^cp:[a-z0-9]+:s0$/);
    assert.match(keyboard[2][0].callback_data, /^cp:[a-z0-9]+:s3$/);
    suggestionData = keyboard[2][0].callback_data;
    return { ok: true, result: { message_id: 101, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: {
        id: "cb-suggestion",
        from: { id: 777 },
        message: { message_id: 101, chat: { id: 123 } },
        data: suggestionData,
      },
    }],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 101 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    suggestions: [
      { index: 0, label: "Always Bash" },
      { index: 3, label: "Auto edits" },
    ],
  });
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.deepEqual(decision, { action: "suggestion", index: 3 });
  await runner.stop();
});

test("native runner rejects forged suggestion callbacks and waits for a valid decision", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let forgedSuggestionData = "";
  let validSuggestionData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    const keyboard = payload.reply_markup.inline_keyboard;
    forgedSuggestionData = keyboard[0][0].callback_data.replace(/:a$/, ":s99");
    validSuggestionData = keyboard[1][0].callback_data;
    return { ok: true, result: { message_id: 102, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [
      {
        update_id: 1,
        callback_query: {
          id: "cb-forged",
          from: { id: 777 },
          message: { message_id: 102, chat: { id: 123 } },
          data: forgedSuggestionData,
        },
      },
      {
        update_id: 2,
        callback_query: {
          id: "cb-valid",
          from: { id: 777 },
          message: { message_id: 102, chat: { id: 123 } },
          data: validSuggestionData,
        },
      },
    ],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 102 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
    suggestions: [{ index: 0, label: "Always Bash" }],
  });
  await tick();

  releaseFirstPoll({ ok: true, result: [] });
  const decision = await decisionPromise;
  assert.deepEqual(decision, { action: "suggestion", index: 0 });

  const callbackAnswers = server.calls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(callbackAnswers[0].payload.text, "Unavailable");
  assert.equal(callbackAnswers[1].payload.text, "Applied");
  assert.equal(server.calls.filter((call) => call.method === "editMessageReplyMarkup").length, 1);
  await runner.stop();
});

test("native runner requestApproval ignores wrong user and resolves later callback", async () => {
  const server = createFakeTelegramServer();
  let releaseFirstPoll;
  let denyData = "";
  let legacyDenyData = "";

  server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
  server.enqueue("sendMessage", (payload) => {
    denyData = payload.reply_markup.inline_keyboard[0][1].callback_data;
    assert.match(denyData, /^cp:([a-z0-9]+):d$/);
    legacyDenyData = denyData.replace(/^cp:([a-z0-9]+):d$/, "clawdperm:$1:deny");
    return { ok: true, result: { message_id: 100, chat: { id: 123 } } };
  });
  server.enqueue("getUpdates", () => ({
    ok: true,
    result: [
      {
        update_id: 1,
        callback_query: {
          id: "cb-wrong-user",
          from: { id: 999 },
          message: { message_id: 100, chat: { id: 123 } },
          data: legacyDenyData,
        },
      },
      {
        update_id: 2,
        callback_query: {
          id: "cb-deny",
          from: { id: 777 },
          message: { message_id: 100, chat: { id: 123 } },
          data: legacyDenyData,
        },
      },
    ],
  }));
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("answerCallbackQuery", true);
  server.enqueueOk("editMessageReplyMarkup", { message_id: 100 });

  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  await runner.start();
  await tick();
  const decisionPromise = runner.requestApproval({
    title: "claude-code requests Bash",
    detail: "Summary: Run tests",
  });
  await tick();
  releaseFirstPoll({ ok: true, result: [] });

  assert.deepEqual(await decisionPromise, { action: "deny" });
  assert.equal(
    server.calls.filter((call) => call.method === "answerCallbackQuery").length,
    2,
  );
  await runner.stop();
});

test("native runner requestApproval resolves null on abort and send failure", async () => {
  {
    const server = createFakeTelegramServer();
    let releaseFirstPoll;
    server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
    server.enqueueOk("sendMessage", { message_id: 1 });

    const runner = createTelegramNativeRunner({
      tokenStore: tokenStore(),
      transport: server.transport,
      getDispatch: () => async () => {},
      getChatId: () => "123",
      getAllowedUserId: () => "777",
    });
    await runner.start();
    await tick();
    const controller = new AbortController();
    const promise = runner.requestApproval(
      { title: "x", detail: "y" },
      { signal: controller.signal },
    );
    controller.abort();
    assert.equal(await promise, null);
    releaseFirstPoll({ ok: true, result: [] });
    await runner.stop();
  }

  {
    const server = createFakeTelegramServer();
    let releaseFirstPoll;
    server.enqueue("getUpdates", () => new Promise((resolve) => { releaseFirstPoll = resolve; }));
    server.enqueueError("sendMessage", { status: 403, description: "Forbidden" });

    const runner = createTelegramNativeRunner({
      tokenStore: tokenStore(),
      transport: server.transport,
      getDispatch: () => async () => {},
      getChatId: () => "123",
      getAllowedUserId: () => "777",
    });
    await runner.start();
    await tick();
    const decision = await runner.requestApproval({ title: "x", detail: "y" });
    assert.equal(decision, null);
    releaseFirstPoll({ ok: true, result: [] });
    await runner.stop();
  }
});

test("native runner requestApproval is disabled until polling with a valid payload", async () => {
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: createFakeTelegramServer().transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });

  assert.equal(runner.isEnabled(), false);
  assert.equal(await runner.requestApproval({ title: "x", detail: "y" }), null);
  assert.equal(await runner.requestApproval({ title: "", detail: "y" }), null);
});

// ── R1a sendNotification ──────────────────────────────────────────────────

// Start polling against a getUpdates that never resolves so `polling` stays
// true (the gate sendNotification checks) without consuming scripted sends.
async function startPolling(server, opts = {}) {
  server.enqueue("getUpdates", () => new Promise(() => {}));
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
    ...opts,
  });
  await runner.start();
  await tick();
  return runner;
}

test("sendNotification posts a plain message with no inline keyboard", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server);
  server.enqueueOk("sendMessage", { message_id: 7 });

  const res = await runner.sendNotification("done: task X");
  assert.deepEqual(res, { ok: true });
  const send = server.calls.find((c) => c.method === "sendMessage");
  assert.equal(send.payload.chat_id, "123");
  assert.equal(send.payload.text, "done: task X");
  assert.equal(send.payload.reply_markup, undefined);
  await runner.stop();
});

test("sendNotification returns not_active when not polling", async () => {
  const server = createFakeTelegramServer();
  const runner = createTelegramNativeRunner({
    tokenStore: tokenStore(),
    transport: server.transport,
    getDispatch: () => async () => {},
    getChatId: () => "123",
    getAllowedUserId: () => "777",
  });
  const res = await runner.sendNotification("nope");
  assert.deepEqual(res, { ok: false, errorClass: "not_active" });
  assert.equal(server.calls.length, 0, "must not call Telegram when inactive");
});

test("sendNotification returns not_active when chat id is missing", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server, { getChatId: () => "" });
  const res = await runner.sendNotification("nope");
  assert.deepEqual(res, { ok: false, errorClass: "not_active" });
  await runner.stop();
});

test("sendNotification retries once on 429 then succeeds", async () => {
  const server = createFakeTelegramServer();
  const slept = [];
  const runner = await startPolling(server, {
    sleep: async (ms) => { slept.push(ms); },
  });
  server.enqueueError("sendMessage", { status: 429, parameters: { retry_after: 2 } });
  server.enqueueOk("sendMessage", { message_id: 9 });

  const res = await runner.sendNotification("retry me");
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(slept, [2000], "honours retry_after seconds");
  assert.equal(server.calls.filter((c) => c.method === "sendMessage").length, 2);
  await runner.stop();
});

test("sendNotification re-reads chat id before the 429 retry", async () => {
  const server = createFakeTelegramServer();
  let chat = "123";
  const runner = await startPolling(server, {
    getChatId: () => chat,
    sleep: async () => { chat = ""; }, // user re-targets during retry_after
  });
  server.enqueueError("sendMessage", { status: 429, parameters: { retry_after: 1 } });

  const res = await runner.sendNotification("retarget mid-retry");
  assert.deepEqual(res, { ok: false, errorClass: "not_active" });
  // Only the first attempt hit the wire; the retry bailed on the cleared chat.
  assert.equal(server.calls.filter((c) => c.method === "sendMessage").length, 1);
  await runner.stop();
});

test("sendNotification bails when the chat target changes during the 429 retry", async () => {
  const server = createFakeTelegramServer();
  let chat = "123";
  const runner = await startPolling(server, {
    getChatId: () => chat,
    sleep: async () => { chat = "456"; }, // re-targeted to a DIFFERENT chat
  });
  server.enqueueError("sendMessage", { status: 429, parameters: { retry_after: 1 } });

  const res = await runner.sendNotification("retargeted mid-retry");
  assert.deepEqual(res, { ok: false, errorClass: "not_active" });
  assert.equal(server.calls.filter((c) => c.method === "sendMessage").length, 1,
    "must not re-fire the ping at the new chat");
  await runner.stop();
});

test("sendNotification drops on 403 without retrying", async () => {
  const server = createFakeTelegramServer();
  const runner = await startPolling(server);
  server.enqueueError("sendMessage", { status: 403, description: "bot was blocked" });

  const res = await runner.sendNotification("blocked");
  assert.deepEqual(res, { ok: false, errorClass: "403" });
  assert.equal(server.calls.filter((c) => c.method === "sendMessage").length, 1);
  await runner.stop();
});
