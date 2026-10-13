"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  actionPreviewSeconds,
  actionNeedsBoundProp,
  buildActionPreviewScript,
  buildStandingPreviewScript,
  pickPreviewStage,
  stripNonCharacterLayers,
  renderActionPreview,
} = require("../src/actionPreview");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");
const { buildRodneyTestProject } = require("./helpers/rodneyTestProject");
const { encodeRgbaPng } = require("../src/pngFlip");
const { resolvePythonBin } = require("../src/pythonRuntime");

describe("action preview helpers", () => {
  test("loops 1-3 seconds and writes a Do: script", () => {
    assert.equal(actionPreviewSeconds(8, 12), 2);
    assert.equal(actionPreviewSeconds(24, 12), 2);
    const script = buildActionPreviewScript("Rodney", "curtain", "walk_side", 2);
    assert.match(script, /\[Location: curtain\]/);
    assert.match(script, /\[Do: Rodney walk_side for=2s wait=false\]/);
    assert.doesNotMatch(script, /prop=/);
  });

  test("binds {prop} actions so grab_mic can parse", () => {
    assert.equal(actionNeedsBoundProp({ prop_events: [{ frame: 0, prop: "{prop}", drawing: "pole" }] }), true);
    assert.equal(actionNeedsBoundProp({ prop_events: [{ frame: 0, prop: "mic_stand", drawing: "pole" }] }), false);
    const script = buildActionPreviewScript("Rodney", "curtain", "grab_mic", 2, { prop: "mic_stand" });
    assert.match(script, /\[Do: Rodney grab_mic prop=mic_stand for=2s wait=false\]/);
    assert.match(buildStandingPreviewScript("Rodney", "curtain"), /\[Action: Rodney at=centre\]/);
    assert.doesNotMatch(buildStandingPreviewScript("Rodney", "curtain"), /\[Do:/);
  });

  test("picks a location that has a prop when the action needs one", () => {
    const fixture = createFixtureLibrary();
    try {
      const empty = pickPreviewStage(fixture.projectDir, fixture.globalAssetsDir, { id: "nod" });
      assert.ok(empty.locationId);
      fixture.writeJson(path.join(fixture.globalAssetsDir, "backgrounds", "room_a", "staging.json"), {
        marks: { centre: { x: 500, y: 1000, scale: 1.0 } },
        auto_order: ["centre"],
        props: {
          mic_stand: { asset: "props/stand.png", x: 700, y: 1000, z: 8 },
        },
      });
      fixture.writePng(path.join(fixture.globalAssetsDir, "backgrounds", "room_a", "props", "stand.png"));
      const needs = pickPreviewStage(fixture.projectDir, fixture.globalAssetsDir, {
        id: "grab_mic",
        prop_events: [{ frame: 0, prop: "{prop}", drawing: "pole" }],
      });
      assert.equal(needs.locationId, "room_a");
      assert.equal(needs.prop, "mic_stand");
    } finally {
      fixture.cleanup();
    }
  });

  test("drops prop layers so the crop is the character only", () => {
    const timeline = {
      scenes: [
        {
          layers: [
            { id: "rodney", character_id: "rodney", asset: "blank.png" },
            { id: "mic_stand", prop_id: "mic_stand", asset: "props/stand.png" },
            { id: "speaker", prop_id: "speaker", asset: "props/speaker.png" },
          ],
        },
      ],
    };
    stripNonCharacterLayers(timeline, "rodney");
    assert.deepEqual(
      timeline.scenes[0].layers.map((layer) => layer.id),
      ["rodney"]
    );
  });
});

describe("action preview render", () => {
  test("grab_mic writes a clip and magenta location props do not survive the crop", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-action-render-"));
    try {
      const projectDir = path.join(root, "rodney_test");
      fs.mkdirSync(projectDir, { recursive: true });
      buildRodneyTestProject(projectDir);

      const stand = Buffer.alloc(64 * 96 * 4, 0);
      for (let i = 0; i < 64 * 96; i += 1) {
        stand[i * 4] = 255;
        stand[i * 4 + 1] = 0;
        stand[i * 4 + 2] = 255;
        stand[i * 4 + 3] = 255;
      }
      const speaker = Buffer.alloc(80 * 64 * 4, 0);
      for (let i = 0; i < 80 * 64; i += 1) {
        speaker[i * 4] = 255;
        speaker[i * 4 + 1] = 0;
        speaker[i * 4 + 2] = 255;
        speaker[i * 4 + 3] = 255;
      }
      const bgDir = path.join(projectDir, "backgrounds", "bedroom");
      fs.mkdirSync(path.join(bgDir, "props"), { recursive: true });
      fs.writeFileSync(path.join(bgDir, "bg.png"), encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4)));
      fs.writeFileSync(path.join(bgDir, "props", "stand.png"), encodeRgbaPng(64, 96, stand));
      fs.writeFileSync(path.join(bgDir, "props", "speaker.png"), encodeRgbaPng(80, 64, speaker));
      fs.writeFileSync(
        path.join(bgDir, "staging.json"),
        `${JSON.stringify({
          marks: { centre: { x: 500, y: 1000, scale: 1 } },
          auto_order: ["centre"],
          props: {
            mic_stand: { asset: "props/stand.png", x: 820, y: 980, z: 8, drawings: { default: "props/stand.png", pole: "props/stand.png" } },
            speaker: { asset: "props/speaker.png", x: 900, y: 1000, z: 7 },
          },
        })}\n`
      );

      const actions = path.join(projectDir, "characters", "rodney", "actions");
      fs.mkdirSync(actions, { recursive: true });
      fs.writeFileSync(
        path.join(actions, "grab_mic.json"),
        `${JSON.stringify({
          id: "grab_mic",
          view: "front",
          fps: 12,
          frames: 4,
          set_slots: { torso: "neutral" },
          prop_events: [
            { frame: 0, prop: "{prop}", drawing: "pole" },
            { frame: 0, prop: "{prop}", z: 5 },
          ],
        })}\n`
      );
      fs.writeFileSync(
        path.join(actions, "nod.json"),
        `${JSON.stringify({ id: "nod", view: "front", fps: 12, frames: 4, set_slots: { torso: "neutral" } })}\n`
      );

      const grabDest = path.join(root, "grab_mic.mp4");
      const nodDest = path.join(root, "nod.mp4");
      await renderActionPreview(projectDir, null, "rodney", "grab_mic", grabDest);
      await renderActionPreview(projectDir, null, "rodney", "nod", nodDest);
      assert.ok(fs.statSync(grabDest).size > 1000, "grab_mic tile must not be an empty file");
      assert.ok(fs.statSync(nodDest).size > 1000, "nod tile must not be an empty file");

      const frame = path.join(root, "grab_frame.png");
      const extracted = spawnSync("ffmpeg", ["-y", "-i", grabDest, "-vframes", "1", frame], { encoding: "utf8" });
      assert.equal(extracted.status, 0, extracted.stderr || "ffmpeg frame extract failed");
      const probe = spawnSync(
        resolvePythonBin(),
        [
          "-c",
          "import sys, cv2, numpy as np; im=cv2.imread(sys.argv[1]); b,g,r=cv2.split(im); mag=((r>200)&(b>200)&(g<40)).sum(); sys.exit(1 if mag>20 else 0)",
          frame,
        ],
        { encoding: "utf8" }
      );
      assert.equal(probe.status, 0, "magenta mic/speaker props must not remain in the cropped clip");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
