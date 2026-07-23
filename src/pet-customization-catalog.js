"use strict";

// Canonical catalog for pet customization choices. Persisted settings store
// stable ids only; renderer-facing values are resolved here so neither menus
// nor untrusted preference data can supply arbitrary CSS filters.

const PET_TINT_CATALOG = Object.freeze([
  Object.freeze({
    id: "none",
    labelKey: "tintNone",
    filter: "",
  }),
  Object.freeze({
    id: "midnight",
    labelKey: "tintMidnight",
    filter: "hue-rotate(200deg) saturate(1.2) brightness(0.82)",
  }),
  Object.freeze({
    id: "gold",
    labelKey: "tintGold",
    filter: "sepia(0.8) saturate(2.2) hue-rotate(-18deg) brightness(1.05)",
  }),
  Object.freeze({
    id: "vaporwave",
    labelKey: "tintVaporwave",
    filter: "hue-rotate(265deg) saturate(1.6) contrast(1.05)",
  }),
  Object.freeze({
    id: "matcha",
    labelKey: "tintMatcha",
    filter: "hue-rotate(75deg) saturate(1.25) brightness(1)",
  }),
  Object.freeze({
    id: "mono",
    labelKey: "tintMono",
    filter: "grayscale(1) brightness(1.05)",
  }),
]);

const PET_TINT_BY_ID = new Map(PET_TINT_CATALOG.map((entry) => [entry.id, entry]));
const PET_TINT_IDS = Object.freeze(PET_TINT_CATALOG.map((entry) => entry.id));

function isPetTintId(value) {
  return typeof value === "string" && PET_TINT_BY_ID.has(value);
}

function getPetTint(value) {
  return PET_TINT_BY_ID.get(value) || PET_TINT_BY_ID.get("none");
}

function resolvePetTintPayload(value) {
  const entry = getPetTint(value);
  return {
    id: entry.id,
    filter: entry.filter,
  };
}

function listPetTintOptions() {
  return PET_TINT_CATALOG.map(({ id, labelKey }) => ({ id, labelKey }));
}

module.exports = {
  PET_TINT_CATALOG,
  PET_TINT_IDS,
  isPetTintId,
  getPetTint,
  resolvePetTintPayload,
  listPetTintOptions,
};
