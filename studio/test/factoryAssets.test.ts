import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ASSET_SECTIONS,
  BADGE_LABEL,
  FACTORY_VIEW_TABS,
  formatBounds,
  formatCountLine,
  formatPivot,
  groupActionsByCharacter,
  groupAudioFolders,
  groupScripts,
  isOldScript,
  newestScriptName,
  pickActiveScript,
  isFactoryBadge,
  pivotPercent,
  sectionLabel,
  soundDisplayName,
  sourceLabel,
  visibleDrawings,
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
    assert.equal(formatBounds({ x: 460, y: 342, w: 102, h: 120 }), "460,342 → 562,462");
    assert.deepEqual(
      groupAudioFolders([
        { label: "big_red_nude_truck", rel: "audio/big_red_nude_truck/001_rodney.wav" },
        { label: "big_red_nude_truck", rel: "audio/big_red_nude_truck/002_rodney.wav" },
        { label: "rodney_jepps", rel: "audio/rodney_jepps/001_rodney.wav" },
      ]).map((folder) => [folder.label, folder.count]),
      [
        ["big_red_nude_truck", 2],
        ["rodney_jepps", 1],
      ]
    );
  });

  test("newest script wins by mtime and old-script badge follows it", () => {
    const files = [
      { name: "script.txt", mtime: 10 },
      { name: "script_full_test.txt", mtime: 40 },
      { name: "script_old_walk.txt", mtime: 20 },
    ];
    assert.equal(newestScriptName(files), "script_full_test.txt");
    assert.equal(pickActiveScript(files, "script.txt", false), "script_full_test.txt");
    assert.equal(pickActiveScript(files, "script.txt", true), "script.txt");
    assert.equal(isOldScript("script.txt", "script_full_test.txt"), true);
    assert.equal(isOldScript("script_full_test.txt", "script_full_test.txt"), false);
  });

  test("script dropdown pins the three current scripts and groups the rest under tests", () => {
    assert.deepEqual(
      groupScripts([
        "script_old_walk.txt",
        "script_showcase_v2.txt",
        "script.txt",
        "script_full_test.txt",
        "script_mouth_check.txt",
      ]),
      {
        pinned: ["script.txt", "script_full_test.txt", "script_showcase_v2.txt"],
        tests: ["script_mouth_check.txt", "script_old_walk.txt"],
      }
    );
  });

  test("action shots group under the character and hide missing tiles by default", () => {
    const groups = groupActionsByCharacter(
      [
        { id: "walk_side", label: "rodney/walk_side", characterId: "rodney", name: "walk_side" },
        { id: "nod", label: "rodney/nod", characterId: "rodney", name: "nod" },
        { id: "blink", label: "shared/blink", characterId: null, name: "blink" },
      ],
      [{ id: "rodney", display_name: "Rodney" }]
    );
    assert.equal(groups[0].characterName, "Rodney");
    assert.deepEqual(
      groups[0].actions.map((item) => item.label),
      ["walk_side", "nod"]
    );
    assert.equal(sectionLabel("actions"), "Action Shots");
    assert.deepEqual(
      ASSET_SECTIONS.map((item) => item.label),
      ["Characters", "Props", "Backgrounds", "Action Shots", "Sounds"]
    );
    assert.deepEqual(
      visibleDrawings([{ name: "open", missing: false }, { name: "half", missing: true }], false).map((item) => item.name),
      ["open"]
    );
    assert.equal(soundDisplayName({ label: "truck", rel: "audio/truck/001_rodney.wav" }, false), "truck");
    assert.equal(soundDisplayName({ label: "truck", rel: "audio/truck/002_rodney.wav" }, true), "truck 002_rodney");
  });
});
