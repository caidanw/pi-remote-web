import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCustomization } from "./customization.js";

describe("customization schema", () => {
  it("keeps only safe v1 values", () => {
    const { config, warnings } = validateCustomization({
      version: 1,
      appearance: { sidebarWidth: 321, rightSidebarWidth: 444, density: "compact" },
      motion: { intensity: "none" },
      sound: { enabled: false, volume: 0.5, turnComplete: "sounds/done.ogg" },
      theme: { accent: "#7c6cff", radius: "10px" },
    });
    assert.equal(warnings.length, 0);
    assert.equal(config.appearance.sidebarWidth, 321);
    assert.equal(config.sound.turnComplete, "sounds/done.ogg");
    assert.equal(config.theme.accent, "#7c6cff");
  });

  it("warns and drops unsafe values", () => {
    const { config, warnings } = validateCustomization({
      version: 2,
      appearance: { sidebarWidth: 9999, density: "tiny" },
      sound: { volume: 2, turnComplete: "../secret.ogg" },
      theme: { accent: "red", radius: "url(x)" },
    });
    assert.equal(config.version, 1);
    assert.equal(config.appearance.sidebarWidth, undefined);
    assert.ok(warnings.length >= 6);
  });
});
