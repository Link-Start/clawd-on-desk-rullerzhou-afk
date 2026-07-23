"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  PET_TINT_CATALOG,
  PET_TINT_IDS,
  isPetTintId,
  getPetTint,
  isPetTintSupportedForTheme,
  resolvePetTintPayload,
  listPetTintOptions,
} = require("../src/pet-customization-catalog");

describe("pet customization catalog", () => {
  it("keeps one ordered, immutable source of truth for persisted tint ids", () => {
    assert.deepStrictEqual(
      PET_TINT_IDS,
      ["none", "midnight", "gold", "vaporwave", "matcha", "mono"]
    );
    assert.strictEqual(new Set(PET_TINT_IDS).size, PET_TINT_IDS.length);
    assert.ok(Object.isFrozen(PET_TINT_CATALOG));
    assert.ok(PET_TINT_CATALOG.every(Object.isFrozen));
    assert.ok(Object.isFrozen(PET_TINT_IDS));
  });

  it("exposes labels to Settings without exposing CSS filter values", () => {
    const options = listPetTintOptions();
    assert.deepStrictEqual(
      options,
      PET_TINT_CATALOG.map(({ id, labelKey }) => ({ id, labelKey }))
    );
    assert.ok(options.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "filter")));
  });

  it("resolves only catalog entries and safely falls back to none", () => {
    assert.strictEqual(isPetTintId("gold"), true);
    assert.strictEqual(isPetTintId("custom"), false);
    assert.strictEqual(getPetTint("custom").id, "none");
    assert.deepStrictEqual(resolvePetTintPayload("custom"), { id: "none", filter: "" });
    assert.deepStrictEqual(resolvePetTintPayload(null), { id: "none", filter: "" });
  });

  it("opts unsupported themes out without changing the persisted semantic choice", () => {
    const calico = { _id: "calico", _builtin: true, _capabilities: { petTint: false } };
    assert.strictEqual(isPetTintSupportedForTheme(calico), false);
    assert.deepStrictEqual(
      resolvePetTintPayload("vaporwave", calico),
      { id: "none", filter: "" }
    );
  });

  it("keeps semantic labels stable while swapping Cloudling's vaporwave and matcha recipes", () => {
    const clawd = { _id: "clawd", _builtin: true, _capabilities: { petTint: true } };
    const cloudling = { _id: "cloudling", _builtin: true, _capabilities: { petTint: true } };

    assert.strictEqual(isPetTintSupportedForTheme(clawd), true);
    assert.deepStrictEqual(resolvePetTintPayload("vaporwave", clawd), {
      id: "vaporwave",
      filter: getPetTint("vaporwave").filter,
    });
    assert.deepStrictEqual(resolvePetTintPayload("vaporwave", cloudling), {
      id: "vaporwave",
      filter: getPetTint("matcha").filter,
    });
    assert.deepStrictEqual(resolvePetTintPayload("matcha", cloudling), {
      id: "matcha",
      filter: getPetTint("vaporwave").filter,
    });
  });

  it("does not apply built-in aliases to an untrusted theme with the same id", () => {
    const external = { _id: "cloudling", _builtin: false, _capabilities: { petTint: true } };
    assert.strictEqual(
      resolvePetTintPayload("vaporwave", external).filter,
      getPetTint("vaporwave").filter
    );
  });

  it("contains only the renderer's deliberately narrow local filter grammar", () => {
    const token =
      /^(?:hue-rotate\(-?\d+(?:\.\d+)?deg\)|(?:saturate|brightness|contrast|sepia|grayscale)\(\d+(?:\.\d+)?\))$/;
    for (const entry of PET_TINT_CATALOG) {
      assert.match(entry.id, /^[a-z][a-z0-9-]{0,31}$/);
      assert.match(entry.labelKey, /^[A-Za-z][A-Za-z0-9]{0,63}$/);
      if (entry.id === "none") {
        assert.strictEqual(entry.filter, "");
      } else {
        assert.ok(entry.filter.split(/\s+/).every((part) => token.test(part)), entry.filter);
      }
      assert.doesNotMatch(entry.filter, /url|var|;|#/i);
    }
  });
});
