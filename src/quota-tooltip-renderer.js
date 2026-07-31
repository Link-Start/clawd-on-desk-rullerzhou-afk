"use strict";

const cardEl = document.getElementById("tooltip-card");
const titleEl = document.getElementById("tooltip-title");
const sourceEl = document.getElementById("tooltip-source");
const rowsEl = document.getElementById("tooltip-rows");

function renderTooltip(payload) {
  const safe = payload && typeof payload === "object" ? payload : {};
  const placement = ["left", "right", "above", "below"].includes(safe.placement)
    ? safe.placement
    : "left";
  cardEl.className = `tooltip-card placement-${placement}`;
  titleEl.textContent = typeof safe.title === "string" ? safe.title : "";
  sourceEl.textContent = typeof safe.source === "string" ? safe.source : "";
  sourceEl.hidden = !sourceEl.textContent;
  rowsEl.replaceChildren();

  const rows = Array.isArray(safe.rows) ? safe.rows.slice(0, 2) : [];
  rowsEl.hidden = rows.length === 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = document.createElement("div");
    const severity = ["ok", "warn", "hot", "reset"].includes(row.severity)
      ? row.severity
      : "ok";
    item.className = `tooltip-row severity-${severity}`;

    const dot = document.createElement("span");
    dot.className = "tooltip-dot";
    dot.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "tooltip-copy";
    const top = document.createElement("span");
    top.className = "tooltip-row-top";
    const label = document.createElement("span");
    label.className = "tooltip-label";
    label.textContent = typeof row.label === "string" ? row.label : "";
    const value = document.createElement("span");
    value.className = "tooltip-value";
    value.textContent = typeof row.value === "string" ? row.value : "";
    top.append(label, value);
    copy.appendChild(top);
    if (typeof row.meta === "string" && row.meta) {
      const meta = document.createElement("span");
      meta.className = "tooltip-meta";
      meta.textContent = row.meta;
      copy.appendChild(meta);
    }
    item.append(dot, copy);
    rowsEl.appendChild(item);
  }
}

window.quotaTooltipAPI.onPayload(renderTooltip);
