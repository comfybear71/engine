import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyPropEdit, propTagLine, propVisibleAt, scenePropStates } from "../lib/stageProps.ts";
import type { PropAsset, StageLayer } from "../lib/worker";

const scenes = [{ id: "intro", startFrame: 0, endFrame: 96 }];
const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: Hi.", "[Scene: Outro]", "[Location: room_a]"].join("\n");

const layer = (over: Partial<StageLayer>): StageLayer => ({
  id: "l",
  z: 1,
  kind: "prop",
  character_id: null,
  prop_id: "plant",
  start_frame: 0,
  end_frame: null,
  ...over,
});
const prop = (id: string, location: string, over: Partial<PropAsset> = {}): PropAsset => ({
  id,
  location,
  z: 1,
  x: 100,
  y: 200,
  scale: 1,
  anchor: "bottom-center",
  thumbRel: null,
  ...over,
});

describe("stage props add/remove", () => {
  test("visibility follows the layer's scene-local frame range", () => {
    const layers = [layer({ start_frame: 24, end_frame: 48 }), layer({ id: "m", prop_id: "mic", start_frame: 0 })];
    assert.equal(propVisibleAt(layers, "plant", 10), false);
    assert.equal(propVisibleAt(layers, "plant", 24), true);
    assert.equal(propVisibleAt(layers, "plant", 48), false);
    assert.equal(propVisibleAt(layers, "mic", 500), true);
    assert.equal(propVisibleAt([layer({ kind: "character", prop_id: null })], "plant", 0), false);
  });

  test("only props of the scene's location are listed, visible ones first", () => {
    const states = scenePropStates(
      [prop("plant", "room_a"), prop("mic", "room_a"), prop("desk", "room_b"), prop("lamp", "room_a", { x: null, y: null })],
      "room_a",
      [layer({ prop_id: "mic" })],
      0
    );
    assert.deepEqual(
      states.map((s) => [s.id, s.visible, s.placed]),
      [
        ["mic", true, true],
        ["lamp", false, false],
        ["plant", false, true],
      ]
    );
    assert.deepEqual(scenePropStates([prop("plant", "room_a")], null, [], 0), []);
  });

  test("tag lines carry at_time, and a position only when the prop has none", () => {
    assert.equal(propTagLine({ propId: "plant", action: "hide", sceneLocalFrame: 48, fps: 24 }), "[Prop: plant hide at_time=2s]");
    assert.equal(propTagLine({ propId: "plant", action: "show", sceneLocalFrame: 0, fps: 24 }), "[Prop: plant show at_time=0s]");
    assert.equal(
      propTagLine({ propId: "lamp", action: "show", sceneLocalFrame: 24, fps: 24, at: { x: 960.4, y: 918 } }),
      "[Prop: lamp show at=960,918 at_time=1s]"
    );
  });

  test("remove from here writes a hide at the playhead inside the current scene", () => {
    const next = applyPropEdit({
      script,
      propId: "plant",
      action: "hide",
      scope: "here",
      frame: 48,
      fps: 24,
      scenes,
      playheadLine: 4,
      placed: true,
      defaultAt: { x: 960, y: 900 },
    });
    assert.deepEqual(next.split("\n").slice(3, 6), ["Alice: Hi.", "[Prop: plant hide at_time=2s]", "[Scene: Outro]"]);
  });

  test("remove from scene writes the hide at 0s, still inside this scene", () => {
    const next = applyPropEdit({
      script,
      propId: "plant",
      action: "hide",
      scope: "scene",
      frame: 48,
      fps: 24,
      scenes,
      playheadLine: 4,
      placed: true,
      defaultAt: { x: 960, y: 900 },
    });
    const lines = next.split("\n");
    const hide = lines.indexOf("[Prop: plant hide at_time=0s]");
    assert.ok(hide > lines.indexOf("[Location: room_a]"));
    assert.ok(hide < lines.indexOf("[Scene: Outro]"));
  });

  test("adding a prop that has no staging position gives it a default spot", () => {
    const next = applyPropEdit({
      script,
      propId: "lamp",
      action: "show",
      scope: "here",
      frame: 24,
      fps: 24,
      scenes,
      playheadLine: null,
      placed: false,
      defaultAt: { x: 960, y: 918 },
    });
    assert.match(next, /\[Prop: lamp show at=960,918 at_time=1s\]/);
  });
});
