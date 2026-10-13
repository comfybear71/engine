"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  actionPreviewSeconds,
  actionNeedsBoundProp,
  buildActionPreviewScript,
  buildStandingPreviewScript,
  pickPreviewStage,
  stripNonCharacterLayers,
} = require("../src/actionPreview");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");

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
