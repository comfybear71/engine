import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BADGE_LABEL,
  FACTORY_VIEW_TABS,
  formatCountLine,
  formatPivot,
  isFactoryBadge,
  pivotPercent,
  sourceLabel,
} from "../lib/factoryAssets.ts";

describe("factory Assets helpers", () => {
  test("view tabs match the mockup order and short labels", () => {
    assert.deepEqual(
      FACTORY_VIEW_TABS.map((tab) => [tab.id, tab.label]),
      [
        ["front", "Front"],
        ["left_34", "L 3/4"],
        ["right_34", "R 3/4"],
        ["left_side", "Side L"],
        ["right_side", "Side R"],
        ["back", "Back"],
      ]
    );
  });

  test("badge labels and header counts stay slim", () => {
    assert.equal(isFactoryBadge("ticked"), true);
    assert.equal(isFactoryBadge("wired"), false);
    assert.equal(BADGE_LABEL.missing, "missing");
    assert.equal(
      formatCountLine({ ticked: 34, locked: 0, draft: 2, missing: 8 }),
      "34 ticked · 2 draft · 8 missing"
    );
    assert.equal(sourceLabel("project"), "project-local");
  });

  test("pivot overlay uses canvas percent so the inspector dot lands on the pixel", () => {
    const at = pivotPercent({ x: 512, y: 256 }, { w: 1024, h: 1024 });
    assert.equal(at.left, 50);
    assert.equal(at.top, 25);
    assert.equal(formatPivot({ x: 509.4, y: 457.2 }), "509 / 457");
  });
});
