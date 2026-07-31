"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const payloadListeners = new Set();

ipcRenderer.on("quota-tooltip:payload", (_event, payload) => {
  for (const listener of payloadListeners) {
    try { listener(payload); } catch (err) { console.warn("quota tooltip listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("quotaTooltipAPI", {
  onPayload(listener) {
    if (typeof listener !== "function") return () => {};
    payloadListeners.add(listener);
    return () => payloadListeners.delete(listener);
  },
});
