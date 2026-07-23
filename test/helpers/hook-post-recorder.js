// test/helpers/hook-post-recorder.js — preload for the WorkBuddy session_id
// filter contract test (#618 / #648).
//
// Loaded via `node --require` in front of the REAL workbuddy-hook.js so the
// assertions run against the shipped adapter, not a re-implementation. Two jobs,
// both before the hook's module body runs:
//
//   1. RECORD every outbound HTTP attempt — both the probe (http.get) and the
//      POST (http.request) that postStateToRunningServer makes — then fail it so
//      nothing escapes the test box and a hung socket never keeps the process
//      alive.
//   2. Dump the recording on exit. The parent points USERPROFILE/HOME at an
//      empty dir, so there is no ~/.clawd/runtime.json and every port looks
//      offline. That is deliberate: it means the ONLY thing that can make the
//      recording empty is the hook choosing not to contact Clawd at all.
//
// The distinction that matters:
//   - A payload WITH session_id enters postStateToRunningServer, which probes
//     the port range → the recording is non-empty even while offline.
//   - A payload WITHOUT session_id must short-circuit before postState is ever
//     called → the recording is exactly []. That empty array is the proof the
//     hook produced no phantom "default" session.

const fs = require("fs");
const http = require("http");
const { EventEmitter } = require("events");

const attempts = [];

function record(kind, args) {
  const opts = args && typeof args[0] === "object" ? args[0] : {};
  attempts.push({
    kind,
    port: opts && opts.port != null ? opts.port : null,
    method: (opts && opts.method) || (kind === "get" ? "GET" : "POST"),
    path: (opts && opts.path) || null,
  });
}

function blockedRequest() {
  const req = new EventEmitter();
  const fail = () => process.nextTick(() => req.emit("error", new Error("blocked by hook-post-recorder")));
  req.end = () => { fail(); return req; };
  req.write = () => true;
  req.destroy = () => req;
  req.setTimeout = () => req;
  return req;
}

http.get = (...args) => {
  record("get", args);
  const req = blockedRequest();
  process.nextTick(() => req.emit("error", new Error("blocked by hook-post-recorder")));
  return req;
};
http.request = (...args) => {
  record("request", args);
  return blockedRequest();
};

process.on("exit", () => {
  const out = process.env.CLAWD_POST_OUT;
  if (!out) return;
  try { fs.writeFileSync(out, JSON.stringify(attempts), "utf8"); } catch { /* best effort */ }
});
