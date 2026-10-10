"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { assignActionLane, buildLaneBlocks, clampFrame } = require("../src/studioLanes");

describe("studio lanes playhead", () => {
  test("clampFrame stays on [0, totalFrames-1]", () => {
    assert.equal(clampFrame(287, 285), 284);
    assert.equal(clampFrame(-1, 285), 0);
    assert.equal(clampFrame(0, 1), 0);
    assert.equal(clampFrame(99, 1), 0);
  });

  test("totalFrames is the playable length even if a block extends past it", () => {
    const built = buildLaneBlocks({
      timeline: { fps: 24 },
      sceneLengths: [{ id: "intro", frames: 10 }],
      laneEvents: [
        {
          lane: "action",
          sceneId: "intro",
          startFrame: 0,
          endFrame: 12,
          label: "hold",
          scriptLine: 2,
          subject: "Alice",
        },
      ],
    });
    assert.equal(built.totalFrames, 10);
    assert.equal(built.blocks[0].lane, "body");
    assert.equal(built.blocks[0].endFrame, 12);
    assert.equal(built.blocks[0].rel, null);
    assert.equal(clampFrame(built.blocks[0].endFrame, built.totalFrames), 9);
  });

  test("passes audio rel through to the block", () => {
    const built = buildLaneBlocks({
      timeline: { fps: 24 },
      sceneLengths: [{ id: "intro", frames: 24 }],
      laneEvents: [
        {
          lane: "audio",
          sceneId: "intro",
          startFrame: 0,
          endFrame: 12,
          label: "001_alice.wav",
          scriptLine: 4,
          rel: "audio/intro/001_alice.wav",
        },
      ],
    });
    assert.equal(built.blocks[0].rel, "audio/intro/001_alice.wav");
  });
});

describe("studio action lane assignment", () => {
  test("splits Action into body, face, and props; timed moves keep over=/for=", () => {
    assert.equal(assignActionLane({ lane: "action", tag: "move" }), "body");
    assert.equal(assignActionLane({ lane: "action", tag: "swing" }), "body");
    assert.equal(assignActionLane({ lane: "action", tag: "pose" }), "body");
    assert.equal(assignActionLane({ lane: "action", tag: "action", keys: ["body"] }), "body");
    assert.equal(assignActionLane({ lane: "action", tag: "action", keys: ["eyes"] }), "face");
    assert.equal(assignActionLane({ lane: "action", tag: "action", keys: ["face"] }), "face");
    assert.equal(assignActionLane({ lane: "action", tag: "prop", subjectKind: "prop" }), "props");
    assert.equal(assignActionLane({ lane: "action", tag: "layer", subjectKind: "prop" }), "props");
    assert.equal(assignActionLane({ lane: "camera", tag: "camera" }), "camera");

    const built = buildLaneBlocks({
      timeline: { fps: 24 },
      sceneLengths: [{ id: "intro", frames: 48 }],
      laneEvents: [
        {
          lane: "action",
          tag: "action",
          keys: ["body"],
          sceneId: "intro",
          startFrame: 0,
          endFrame: 0,
          label: "alice body=walk_side",
          scriptLine: 3,
          subject: "alice",
        },
        {
          lane: "action",
          tag: "move",
          sceneId: "intro",
          startFrame: 0,
          endFrame: 24,
          label: "alice → right",
          scriptLine: 4,
          subject: "alice",
        },
        {
          lane: "action",
          tag: "action",
          keys: ["eyes"],
          sceneId: "intro",
          startFrame: 0,
          endFrame: 0,
          label: "alice eyes=closed",
          scriptLine: 5,
          subject: "alice",
        },
        {
          lane: "action",
          tag: "prop",
          sceneId: "intro",
          startFrame: 12,
          endFrame: 12,
          label: "lamp show",
          scriptLine: 6,
          subject: "lamp",
          subjectKind: "prop",
        },
        {
          lane: "camera",
          tag: "camera",
          sceneId: "intro",
          startFrame: 0,
          endFrame: 24,
          label: "zoom=1.3",
          scriptLine: 2,
        },
      ],
    });
    assert.deepEqual(built.lanes, ["body", "face", "props", "dialogue", "audio", "sfx", "camera"]);
    const byLane = (id) => built.blocks.filter((b) => b.lane === id);
    assert.ok(byLane("body").some((b) => b.scriptLine === 3));
    assert.ok(byLane("body").some((b) => b.scriptLine === 4));
    assert.ok(byLane("face").some((b) => b.scriptLine === 5));
    assert.ok(byLane("props").some((b) => b.scriptLine === 6));
    assert.ok(byLane("camera").some((b) => b.scriptLine === 2));

    const move = byLane("body").find((b) => b.scriptLine === 4);
    const walk = byLane("body").find((b) => b.scriptLine === 3);
    const face = byLane("face")[0];
    assert.equal(move.endFrame, 24);
    assert.equal(walk.endFrame, 48);
    assert.equal(face.startFrame, 0);
    assert.equal(face.endFrame, 48);
    assert.ok(walk.startFrame < move.endFrame && move.startFrame < walk.endFrame);
  });

  test("stacks overlapping blocks in the same lane into sub-rows", () => {
    const built = buildLaneBlocks({
      timeline: { fps: 24 },
      sceneLengths: [{ id: "intro", frames: 48 }],
      laneEvents: [
        {
          lane: "action",
          tag: "move",
          sceneId: "intro",
          startFrame: 0,
          endFrame: 24,
          label: "alice → right",
          scriptLine: 4,
          subject: "alice",
        },
        {
          lane: "action",
          tag: "swing",
          sceneId: "intro",
          startFrame: 0,
          endFrame: 24,
          label: "alice swing",
          scriptLine: 5,
          subject: "alice",
        },
        {
          lane: "action",
          tag: "move",
          sceneId: "intro",
          startFrame: 24,
          endFrame: 48,
          label: "bob → left",
          scriptLine: 6,
          subject: "bob",
        },
      ],
    });
    const body = built.blocks.filter((b) => b.lane === "body");
    const move = body.find((b) => b.scriptLine === 4);
    const swing = body.find((b) => b.scriptLine === 5);
    const later = body.find((b) => b.scriptLine === 6);
    assert.equal(move.row === swing.row, false);
    assert.equal(later.row, 0);
    assert.equal(Math.max(move.row, swing.row), 1);
  });
});
