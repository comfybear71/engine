"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { buildLaneBlocks, clampFrame } = require("../src/studioLanes");

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
