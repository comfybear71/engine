import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyAssetDropToScript,
  applyStagePlacement,
  assetFitsLane,
  nearestMark,
  scriptLineForAssetDrop,
  setSceneLocation,
  slotLane,
} from "../lib/stageAssets.ts";

const scenes = [{ id: "intro", startFrame: 0, endFrame: 96, frames: 96 }];
const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: Hi."].join("\n");

describe("stage asset drops", () => {
  test("drawings and cycles become Action tags on the fitting lane", () => {
    assert.equal(slotLane("face"), "face");
    assert.equal(slotLane("eyes"), "face");
    assert.equal(slotLane("body"), "body");
    assert.equal(slotLane("right_hand"), "body");
    assert.equal(slotLane("mouth"), null);
    assert.equal(
      scriptLineForAssetDrop(
        { kind: "drawing", characterId: "alice", characterName: "Alice", slot: "face", drawing: "yap" },
        24,
        48
      ),
      "[Action: Alice face=yap at_time=2s]"
    );
    assert.equal(
      scriptLineForAssetDrop(
        { kind: "cycle", characterId: "alice", characterName: "Alice", slot: "body", cycle: "walk_side" },
        24,
        0
      ),
      "[Action: Alice body=walk_side at_time=0s]"
    );
    assert.equal(
      scriptLineForAssetDrop(
        { kind: "drawing", characterId: "alice", characterName: "Alice", slot: "mouth", drawing: "A" },
        24,
        0
      ),
      null
    );
    assert.equal(
      assetFitsLane(
        { kind: "drawing", characterId: "alice", characterName: "Alice", slot: "face", drawing: "yap" },
        "face"
      ),
      true
    );
    assert.equal(
      assetFitsLane(
        { kind: "drawing", characterId: "alice", characterName: "Alice", slot: "face", drawing: "yap" },
        "body"
      ),
      false
    );
  });

  test("timeline drop inserts the tag; background rewrites Location", () => {
    const withFace = applyAssetDropToScript({
      script,
      asset: { kind: "drawing", characterId: "alice", characterName: "Alice", slot: "face", drawing: "yap" },
      lane: "face",
      frame: 24,
      fps: 24,
      scenes,
      playheadLine: 4,
    });
    assert.match(withFace, /\[Action: Alice face=yap at_time=1s\]/);

    const skipped = applyAssetDropToScript({
      script,
      asset: { kind: "drawing", characterId: "alice", characterName: "Alice", slot: "face", drawing: "yap" },
      lane: "body",
      frame: 24,
      fps: 24,
      scenes,
      playheadLine: 4,
    });
    assert.equal(skipped, script);

    const audio = applyAssetDropToScript({
      script,
      asset: {
        kind: "audio",
        audioKind: "imported",
        label: "monologue",
        characterId: "alice",
        characterName: "Alice",
      },
      lane: "audio",
      frame: 12,
      fps: 24,
      scenes,
      playheadLine: 4,
    });
    assert.match(audio, /\[Audio: Alice file=monologue at_time=0\.5s\]/);

    const generated = applyAssetDropToScript({
      script,
      asset: {
        kind: "audio",
        audioKind: "generated",
        label: "intro",
        characterId: "alice",
        characterName: "Alice",
      },
      lane: "audio",
      frame: 12,
      fps: 24,
      scenes,
      playheadLine: 4,
    });
    assert.equal(generated, script);

    const bg = applyAssetDropToScript({
      script,
      asset: { kind: "background", locationId: "room_b" },
      lane: "body",
      frame: 0,
      fps: 24,
      scenes,
      playheadLine: 1,
    });
    assert.equal(setSceneLocation(script, "intro", "room_b").split("\n")[1], "[Location: room_b]");
    assert.equal(bg.split("\n")[1], "[Location: room_b]");
  });

  test("timeline drop inserts in the scene that owns the drop time", () => {
    const twoScenes = [
      { id: "intro", startFrame: 0, endFrame: 96 },
      { id: "hallway", startFrame: 96, endFrame: 192 },
    ];
    const twoScript = ["[Scene: Intro]", "Alice: Hi.", "[Scene: Hallway]", "Bob: Bye."].join("\n");
    const dropped = applyAssetDropToScript({
      script: twoScript,
      asset: { kind: "drawing", characterId: "alice", characterName: "Alice", slot: "eyes", drawing: "closed" },
      lane: "face",
      frame: 12,
      fps: 24,
      scenes: twoScenes,
      playheadLine: 4,
    });
    const lines = dropped.split("\n");
    assert.equal(lines[2], "[Action: Alice eyes=closed at_time=0.5s]");
    assert.equal(lines[3], "[Scene: Hallway]");
    assert.equal(lines[4], "Bob: Bye.");
  });

  test("stage preview drop places a prop at x,y or a character on the nearest mark", () => {
    const marks = [
      { name: "left", mark: { x: 200, y: 1000 } },
      { name: "right", mark: { x: 1600, y: 1000 } },
    ];
    assert.equal(nearestMark(marks, 210, 990)?.name, "left");
    const prop = applyStagePlacement({
      script,
      asset: { kind: "prop", propId: "letterbox", location: "room_a" },
      x: 640,
      y: 480,
      frame: 24,
      fps: 24,
      scenes,
      playheadLine: 4,
      marks,
    });
    assert.match(prop, /\[Prop: letterbox at=640,480 at_time=1s\]/);
    const character = applyStagePlacement({
      script,
      asset: { kind: "character", characterId: "alice", characterName: "Alice" },
      x: 1580,
      y: 1010,
      frame: 0,
      fps: 24,
      scenes,
      playheadLine: 3,
      marks,
    });
    assert.match(character, /\[Action: Alice at=right at_time=0s\]/);
    const none = applyStagePlacement({
      script,
      asset: { kind: "character", characterId: "alice", characterName: "Alice" },
      x: 10,
      y: 10,
      frame: 0,
      fps: 24,
      scenes,
      playheadLine: 3,
      marks: [],
    });
    assert.equal(none, script);
  });
});
