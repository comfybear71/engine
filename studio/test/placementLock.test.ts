import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectRels, evaluateFrame } from "../../shared/placement.js";

const graph = {
  fps: 24,
  canvas: { width: 40, height: 40 },
  totalFrames: 48,
  scenes: [
    {
      id: "s1",
      totalFrames: 48,
      frameStep: 1,
      camera: null,
      background: { rel: "bg.png", width: 40, height: 40, fit: "cover" },
      layers: [
        {
          id: "rig",
          z: 0,
          rel: "body.png",
          width: 20,
          height: 30,
          startFrame: 0,
          endFrame: null,
          transform: { x: 20, y: 36, scale: 1, rotation: 0, flip_x: false, opacity: 1, anchor: "bottom-center" },
          transformKeyframes: [],
          slots: {},
          children: [
            {
              id: "arm",
              parent: null,
              rel: "arm.png",
              width: 8,
              height: 16,
              z: 1,
              offset_x: 10,
              offset_y: -20,
              pivot: "center",
              scale: 1,
              flip_x: false,
              rotation: 0,
              opacity: 1,
              slots: {
                mouth: {
                  offset_x: 0,
                  offset_y: -8,
                  scale: 1,
                  rotation: 0,
                  images: {
                    A: { rel: "mouth_a.png", width: 6, height: 4 },
                    X: { rel: "mouth_x.png", width: 6, height: 4 },
                  },
                  keyframes: [
                    { frame: 0, drawing: "X" },
                    { frame: 12, drawing: "A" },
                  ],
                },
              },
              rotationKeyframes: [],
              pivot_px: null,
              visible_when: {},
            },
          ],
          groups: {},
          groupRotations: {},
          groupRotationKeyframes: {},
          dialogue: [],
          viewKeyframes: [],
        },
      ],
    },
  ],
};

describe("shared placement lock", () => {
  test("evaluateFrame places the child offset on the parent", () => {
    const { commands } = evaluateFrame(graph, 0);
    const body = commands.find((cmd) => cmd.rel === "body.png");
    const arm = commands.find((cmd) => cmd.rel === "arm.png");
    const mouth = commands.find((cmd) => cmd.rel === "mouth_x.png");
    assert.ok(body);
    assert.ok(arm);
    assert.ok(mouth);
    assert.equal(body.x, 20);
    assert.equal(body.y, 36);
    assert.equal(arm.x, 30);
    assert.equal(arm.y, 16);
    assert.equal(mouth.rel, "mouth_x.png");
  });

  test("held mouth keyframe swaps at frame 12", () => {
    const early = evaluateFrame(graph, 11).commands.find((cmd) => String(cmd.rel).startsWith("mouth_"));
    const late = evaluateFrame(graph, 12).commands.find((cmd) => String(cmd.rel).startsWith("mouth_"));
    assert.equal(early?.rel, "mouth_x.png");
    assert.equal(late?.rel, "mouth_a.png");
  });

  test("collectRels lists every drawing piece", () => {
    const rels = collectRels(graph);
    assert.deepEqual(rels, ["arm.png", "bg.png", "body.png", "mouth_a.png", "mouth_x.png"]);
  });
});
