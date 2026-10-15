import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  backgroundDestRect,
  collectRels,
  evaluateBackgroundRect,
  evaluateFrame,
  sequenceLookahead,
} from "../../shared/placement.js";

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

  test("background dest rect covers the canvas from graph size, not a 512 preview texture", () => {
    const cover = evaluateBackgroundRect(
      {
        fps: 24,
        canvas: { width: 1920, height: 1080 },
        totalFrames: 1,
        scenes: [
          {
            id: "s1",
            totalFrames: 1,
            background: { rel: "curtain.png", width: 1920, height: 1080, fit: "cover" },
            layers: [],
          },
        ],
      },
      0
    );
    assert.deepEqual(cover, { x: 0, y: 0, w: 1920, h: 1080 });

    const wide = evaluateBackgroundRect(
      {
        fps: 24,
        canvas: { width: 1920, height: 1080 },
        totalFrames: 1,
        scenes: [
          {
            id: "s1",
            totalFrames: 1,
            background: { rel: "wide.png", width: 4000, height: 2000, fit: "cover" },
            layers: [],
          },
        ],
      },
      0
    );
    assert.equal(wide?.x, -120);
    assert.equal(wide?.y, 0);
    assert.equal(wide?.w, 2160);
    assert.equal(wide?.h, 1080);

    const previewSized = backgroundDestRect(
      { width: 1920, height: 1080, sx: 1, sy: 1, zoom: 1, cx: 960, cy: 540, originX: 0, originY: 0 },
      1920,
      1080
    );
    assert.deepEqual(previewSized, { x: 0, y: 0, w: 1920, h: 1080 });

    const squareSource = evaluateBackgroundRect(
      {
        fps: 24,
        canvas: { width: 1920, height: 1080 },
        totalFrames: 1,
        scenes: [
          {
            id: "s1",
            totalFrames: 1,
            background: { rel: "bedroom.png", width: 1024, height: 1024, fit: "cover" },
            layers: [],
          },
        ],
      },
      0
    );
    assert.ok(squareSource);
    assert.equal(squareSource.w, 1920);
    assert.equal(squareSource.h, 1920);
    assert.equal(squareSource.x, 0);
    assert.equal(squareSource.y, -420);
    assert.ok(squareSource.y + squareSource.h >= 1080);
  });

  test("flipbook layers draw one frame at a time and are not preloaded wholesale", () => {
    const files = ["a_1.png", "a_2.png", "a_3.png", "a_4.png"];
    const flip = {
      fps: 24,
      canvas: { width: 40, height: 40 },
      totalFrames: 24,
      scenes: [
        {
          id: "s1",
          totalFrames: 24,
          frameStep: 1,
          camera: null,
          background: { rel: "bg.png", width: 40, height: 40, fit: "cover" },
          layers: [
            {
              id: "clip",
              z: 0,
              rel: files[0],
              width: 8,
              height: 8,
              startFrame: 4,
              endFrame: 16,
              transform: { x: 20, y: 30, scale: 1, rotation: 0, flip_x: false, opacity: 1, anchor: "bottom-center" },
              transformKeyframes: [],
              slots: {},
              children: [],
              sequence: { fps: 12, trimIn: 0, files },
            },
          ],
        },
      ],
    };
    assert.deepEqual(collectRels(flip), ["a_1.png", "bg.png"]);
    const relAt = (frame: number) => evaluateFrame(flip, frame).commands.filter((cmd) => cmd.kind === "sprite").map((cmd) => cmd.rel);
    assert.deepEqual(relAt(3), []);
    assert.deepEqual(relAt(4), ["a_1.png"]);
    assert.deepEqual(relAt(6), ["a_2.png"]);
    assert.deepEqual(relAt(15), ["a_4.png"]);
    assert.deepEqual(sequenceLookahead(flip, 4, 4), ["a_1.png", "a_2.png", "a_3.png"]);
  });
});
