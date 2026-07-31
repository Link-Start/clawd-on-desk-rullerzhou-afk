"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const srcDir = path.join(__dirname, "..", "src");

test("quota tooltip uses a dedicated safe, pointer-transparent presentation surface", () => {
  const html = fs.readFileSync(path.join(srcDir, "quota-tooltip.html"), "utf8");
  const renderer = fs.readFileSync(path.join(srcDir, "quota-tooltip-renderer.js"), "utf8");
  const preload = fs.readFileSync(path.join(srcDir, "preload-quota-tooltip.js"), "utf8");

  assert.match(html, /role="tooltip"/);
  assert.match(html, /pointer-events:\s*none/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(renderer, /\.textContent\s*=/);
  assert.doesNotMatch(renderer, /innerHTML/);
  assert.match(preload, /quota-tooltip:payload/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("quotaTooltipAPI"/);
});
