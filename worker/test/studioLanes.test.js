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
    assert.deepEqual(built.lanes, ["body", "face", "props", "dialogue", "mouth", "audio", "sfx", "camera"]);
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

  test("synced dialogue emits one Mouth-lane block; not-synced does not", () => {
    const built = buildLaneBlocks({
      timeline: { fps: 24 },
      sceneLengths: [{ id: "intro", frames: 48 }],
      laneEvents: [
        {
          lane: "dialogue",
          tag: "dialogue",
          sceneId: "intro",
          startFrame: 0,
          endFrame: 24,
          label: "Alice: Hello",
          scriptLine: 4,
          marriedId: "line:intro:4",
          sync: "synced",
          cues: [{ shape: "B", start: 0, end: 0.4 }],
          timing: { kind: "dialogue", attr: "at_time", movable: true },
        },
        {
          lane: "dialogue",
          tag: "dialogue",
          sceneId: "intro",
          startFrame: 24,
          endFrame: 48,
          label: "Alice: Later",
          scriptLine: 5,
          marriedId: "line:intro:5",
          sync: "not_synced",
          cues: [],
          timing: { kind: "dialogue", attr: null, movable: true },
        },
        {
          lane: "action",
          tag: "action",
          keys: ["face"],
          sceneId: "intro",
          startFrame: 0,
          endFrame: 12,
          label: "Alice face=yap",
          scriptLine: 3,
          subject: "alice",
          timing: { kind: "pin", attr: "hold", movable: true },
        },
      ],
    });
    const face = built.blocks.filter((b) => b.lane === "face");
    const mouths = built.blocks.filter((b) => b.lane === "mouth");
    const mouth = mouths[0];
    const pin = face.find((b) => b.scriptLine === 3);
    assert.equal(mouths.length, 1);
    assert.ok(mouth);
    assert.equal(mouth.role, "mouth");
    assert.equal(mouth.startFrame, 0);
    assert.equal(mouth.endFrame, 24);
    assert.equal(mouth.marriedId, "line:intro:4");
    assert.equal(mouth.movable, false);
    assert.equal(mouth.row, 0);
    assert.equal(face.some((b) => b.role === "mouth"), false);
    assert.ok(pin);
    assert.equal(pin.role, "pin");
    assert.equal(pin.faceOverridesMouth, true);
    assert.notEqual(pin.marriedId, mouth.marriedId);
  });

  test("imported-audio sentence mouths stay one-per-dialogue and never stack", () => {
    const sentences = [];
    for (let i = 0; i < 8; i++) {
      sentences.push({
        lane: "dialogue",
        tag: "audio",
        sceneId: "intro",
        startFrame: i * 12,
        endFrame: i * 12 + 12,
        label: `Rodney: sentence ${i}`,
        scriptLine: 6,
        subject: "rodney",
        marriedId: "line:intro:6",
        sync: "synced",
        cues: [{ shape: "B", start: 0, end: 0.2 }],
        timing: { kind: "dialogue", attr: "at_time", movable: true },
      });
    }
    sentences.push({
      lane: "dialogue",
      tag: "audio",
      sceneId: "intro",
      startFrame: 0,
      endFrame: 12,
      label: "Rodney: sentence 0",
      scriptLine: 6,
      subject: "rodney",
      marriedId: "line:intro:6",
      sync: "synced",
      cues: [{ shape: "B", start: 0, end: 0.2 }],
      timing: { kind: "dialogue", attr: "at_time", movable: true },
    });
    const built = buildLaneBlocks({
      timeline: { fps: 24 },
      sceneLengths: [{ id: "intro", frames: 240 }],
      laneEvents: sentences,
    });
    const mouths = built.blocks.filter((b) => b.lane === "mouth").sort((a, b) => a.startFrame - b.startFrame);
    assert.equal(mouths.length, 8);
    assert.equal(new Set(mouths.map((b) => b.id)).size, 8);
    assert.ok(mouths.every((b) => b.row === 0));
    for (let i = 1; i < mouths.length; i++) {
      assert.ok(mouths[i].startFrame >= mouths[i - 1].endFrame);
    }
  });

  test("face pin without hold caps at 2s and warns when face=yap", () => {
    const built = buildLaneBlocks({
      timeline: { fps: 24 },
      sceneLengths: [{ id: "intro", frames: 240 }],
      laneEvents: [
        {
          lane: "action",
          tag: "action",
          keys: ["face"],
          sceneId: "intro",
          startFrame: 0,
          endFrame: 0,
          label: "Rodney face=yap",
          scriptLine: 3,
          subject: "rodney",
          timing: { kind: "pin", attr: null, movable: true },
        },
        {
          lane: "dialogue",
          tag: "dialogue",
          sceneId: "intro",
          startFrame: 72,
          endFrame: 96,
          label: "Rodney: Hi",
          scriptLine: 4,
          subject: "rodney",
          marriedId: "line:intro:4",
          sync: "not_synced",
          cues: [],
        },
      ],
    });
    const pin = built.blocks.find((b) => b.lane === "face");
    assert.ok(pin);
    assert.equal(pin.startFrame, 0);
    assert.equal(pin.endFrame, 48);
    assert.equal(pin.implicitHold, true);
    assert.equal(pin.faceOverridesMouth, true);
    assert.equal(pin.role, "pin");
  });
});
