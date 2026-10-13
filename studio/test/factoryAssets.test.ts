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
  nextNewScriptName,
  normalizeNewScriptName,
  pickActiveScript,
  isFactoryBadge,
  pivotPercent,
  sectionLabel,
  soundDisplayName,
  sourceLabel,
  visibleDrawings,
  pickVisibleProp,
  actionShotCaption,
  actionPreviewSeconds,
  numberedActionPrefix,
  prettyActionFrameLabel,
  splitSlotActionFrames,
  FACTORY_THUMB_PX,
  FACTORY_THUMB_WIDE_PX,
  FACTORY_THUMB_COMPACT_PX,
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
    assert.equal(pickActiveScript(files, "", ""), "script_full_test.txt");
    assert.equal(pickActiveScript(files, "script.txt", "script_full_test.txt"), "script.txt");
    assert.equal(pickActiveScript(files, "", "script.txt"), "script.txt");
    assert.equal(pickActiveScript(files, "", "script_old_walk.txt"), "script_old_walk.txt");
    assert.equal(isOldScript("script.txt", "script_full_test.txt"), true);
    assert.equal(isOldScript("script_full_test.txt", "script_full_test.txt"), false);
  });

  test("script list pins the three current scripts and groups the rest under tests", () => {
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
    assert.equal(normalizeNewScriptName("walk"), "script_walk.txt");
    assert.equal(normalizeNewScriptName("script_walk.txt"), "script_walk.txt");
    assert.equal(normalizeNewScriptName("../secret"), null);
    assert.equal(nextNewScriptName(["script.txt"]), "script_new.txt");
    assert.equal(nextNewScriptName(["script.txt", "script_new.txt"]), "script_new_2.txt");
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
    assert.equal(pickVisibleProp([{ id: "letterbox" }, { id: "mic_stand" }, { id: "speaker" }])?.id, "mic_stand");
    assert.equal(actionPreviewSeconds(8, 12), 2);
    assert.equal(actionPreviewSeconds(4, 12), 2);
    assert.equal(FACTORY_THUMB_PX, 256);
    assert.equal(FACTORY_THUMB_WIDE_PX, 256);
    assert.equal(FACTORY_THUMB_COMPACT_PX, 88);
    assert.equal(actionShotCaption({ still: true, frames: 1 }), "still");
    assert.equal(actionShotCaption({ frames: 4, drawings: 4 }), "4 frames");
    assert.equal(actionShotCaption({ frames: 8, drawings: 4 }), "4 drawings · 8 frames");
  });

  test("numbered walk frames leave Torso as standalone poses and group under the action", () => {
    assert.equal(numberedActionPrefix("walk_side_01"), "walk_side");
    assert.equal(numberedActionPrefix("walk_front_08"), "walk_front");
    assert.equal(numberedActionPrefix("walk_back_2"), "walk_back");
    assert.equal(numberedActionPrefix("grab_mic_03"), "grab_mic");
    assert.equal(numberedActionPrefix("neutral"), null);
    assert.equal(numberedActionPrefix("walk"), null);
    assert.equal(numberedActionPrefix("armless_L"), null);
    assert.equal(prettyActionFrameLabel("walk_side", 8), "Walk side frames (8)");
    const split = splitSlotActionFrames(
      [
        { name: "neutral" },
        { name: "walk" },
        { name: "armless_L" },
        { name: "walk_side_02" },
        { name: "walk_side_01" },
        { name: "walk_side_08" },
        { name: "walk_front_01" },
        { name: "walk_front_02" },
        { name: "approach" },
      ],
      [
        { id: "walk_side", name: "walk_side", characterId: "rodney", label: "rodney/walk_side" },
        { id: "walk_front", name: "walk_front", characterId: "rodney", label: "rodney/walk_front" },
      ],
      "rodney"
    );
    assert.deepEqual(
      split.drawings.map((item) => item.name),
      ["neutral", "walk", "armless_L", "approach"]
    );
    assert.deepEqual(
      split.actionGroups.map((group) => [group.label, group.drawings.map((item) => item.name), group.actionId]),
      [
        ["Walk front frames (2)", ["walk_front_01", "walk_front_02"], "walk_front"],
        ["Walk side frames (3)", ["walk_side_01", "walk_side_02", "walk_side_08"], "walk_side"],
      ]
    );
  });
});
