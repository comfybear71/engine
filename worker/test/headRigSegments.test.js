"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadHeadRig, saveHeadRig } = require("../src/characterLocal");

describe("head rig segment speed and reverse", () => {
  let root;
  let projectDir;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "head-rig-seg-"));
    projectDir = path.join(root, "proj");
    const dir = path.join(projectDir, "characters", "rodney");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify({ id: "rodney", display_name: "Rodney" }));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("speed and reverse survive a save, and the defaults are not stored", () => {
    saveHeadRig(projectDir, null, "rodney", {
      key: "front",
      bodySegments: [
        { shotId: "a", inFrame: 1, outFrame: 10, start: 1, speed: 2, reverse: true },
        { shotId: "a", inFrame: 1, outFrame: 10, start: 6, speed: 1, reverse: false },
      ],
      headSegments: [{ shotId: "h", inFrame: 2, outFrame: 5, start: 1, speed: 0.5, anchorX: 0.5, anchorY: 0.2, headScale: 1 }],
    });
    const rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.equal(rig.bodySegments[0].speed, 2);
    assert.equal(rig.bodySegments[0].reverse, true);
    assert.equal("speed" in rig.bodySegments[1], false);
    assert.equal("reverse" in rig.bodySegments[1], false);
    assert.equal(rig.headSegments[0].speed, 0.5);
  });

  test("a silly speed is rejected", () => {
    assert.throws(
      () => saveHeadRig(projectDir, null, "rodney", { key: "front", bodySegments: [{ shotId: "a", inFrame: 1, outFrame: 3, start: 1, speed: 50 }] }),
      /speed/
    );
  });

  test("body size is kept on body clips only, and the default is not stored", () => {
    saveHeadRig(projectDir, null, "rodney", {
      key: "front",
      bodySegments: [
        { shotId: "a", inFrame: 1, outFrame: 10, start: 1, bodyScale: 0.8 },
        { shotId: "a", inFrame: 1, outFrame: 10, start: 11, bodyScale: 1 },
      ],
      headSegments: [{ shotId: "h", inFrame: 1, outFrame: 5, start: 1, bodyScale: 0.5, anchorX: 0.5, anchorY: 0.2, headScale: 1 }],
    });
    const rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.equal(rig.bodySegments[0].bodyScale, 0.8);
    assert.equal("bodyScale" in rig.bodySegments[1], false);
    assert.equal("bodyScale" in rig.headSegments[0], false);
    assert.throws(
      () => saveHeadRig(projectDir, null, "rodney", { key: "front", bodySegments: [{ shotId: "a", inFrame: 1, outFrame: 3, start: 1, bodyScale: 9 }] }),
      /bodyScale/
    );
  });

  test("the point the body grows around is kept with a body size, and dropped with the default size", () => {
    saveHeadRig(projectDir, null, "rodney", {
      key: "front",
      bodySegments: [
        { shotId: "a", inFrame: 1, outFrame: 10, start: 1, bodyScale: 1.3, bodyPivotX: 0.5, bodyPivotY: 0.18 },
        { shotId: "a", inFrame: 1, outFrame: 10, start: 11, bodyScale: 1, bodyPivotX: 0.5, bodyPivotY: 0.18 },
      ],
    });
    const rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.equal(rig.bodySegments[0].bodyPivotX, 0.5);
    assert.equal(rig.bodySegments[0].bodyPivotY, 0.18);
    assert.equal("bodyPivotY" in rig.bodySegments[1], false);
    assert.throws(
      () => saveHeadRig(projectDir, null, "rodney", { key: "front", bodySegments: [{ shotId: "a", inFrame: 1, outFrame: 3, start: 1, bodyScale: 1.2, bodyPivotY: 4 }] }),
      /bodyPivotY/
    );
  });

  test("body-in-front is kept on body clips only", () => {
    saveHeadRig(projectDir, null, "rodney", {
      key: "front",
      bodySegments: [
        { shotId: "a", inFrame: 1, outFrame: 10, start: 1, bodyInFront: true },
        { shotId: "a", inFrame: 1, outFrame: 10, start: 11 },
      ],
      headSegments: [{ shotId: "h", inFrame: 1, outFrame: 5, start: 1, bodyInFront: true, anchorX: 0.5, anchorY: 0.2, headScale: 1 }],
    });
    const rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.equal(rig.bodySegments[0].bodyInFront, true);
    assert.equal("bodyInFront" in rig.bodySegments[1], false);
    assert.equal("bodyInFront" in rig.headSegments[0], false);
  });

  test("body shift is kept on body clips only, dropped at zero, and rejected when out of range", () => {
    saveHeadRig(projectDir, null, "rodney", {
      key: "front",
      bodySegments: [
        { shotId: "a", inFrame: 1, outFrame: 10, start: 1, bodyOffsetX: 0.1, bodyOffsetY: -0.05 },
        { shotId: "a", inFrame: 1, outFrame: 10, start: 11, bodyOffsetX: 0, bodyOffsetY: 0 },
      ],
      headSegments: [{ shotId: "h", inFrame: 1, outFrame: 5, start: 1, bodyOffsetX: 0.2, anchorX: 0.5, anchorY: 0.2, headScale: 1 }],
    });
    const rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.equal(rig.bodySegments[0].bodyOffsetX, 0.1);
    assert.equal(rig.bodySegments[0].bodyOffsetY, -0.05);
    assert.equal("bodyOffsetX" in rig.bodySegments[1], false);
    assert.equal("bodyOffsetX" in rig.headSegments[0], false);
    assert.throws(
      () => saveHeadRig(projectDir, null, "rodney", { key: "front", bodySegments: [{ shotId: "a", inFrame: 1, outFrame: 3, start: 1, bodyOffsetY: 3 }] }),
      /bodyOffsetY/
    );
  });

  test("follow-body is kept on head clips only, dropped at zero, and rejected when out of range", () => {
    saveHeadRig(projectDir, null, "rodney", {
      key: "front",
      bodySegments: [{ shotId: "a", inFrame: 1, outFrame: 10, start: 1, followBody: 1 }],
      headSegments: [
        { shotId: "h", inFrame: 1, outFrame: 5, start: 1, anchorX: 0.5, anchorY: 0.2, headScale: 1, followBody: 0.75 },
        { shotId: "h", inFrame: 1, outFrame: 5, start: 6, anchorX: 0.5, anchorY: 0.2, headScale: 1, followBody: 0 },
      ],
    });
    const rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.equal(rig.headSegments[0].followBody, 0.75);
    assert.equal("followBody" in rig.headSegments[1], false);
    assert.equal("followBody" in rig.bodySegments[0], false);
    assert.throws(
      () => saveHeadRig(projectDir, null, "rodney", { key: "front", headSegments: [{ shotId: "h", inFrame: 1, outFrame: 3, start: 1, anchorX: 0.5, anchorY: 0.2, headScale: 1, followBody: 4 }] }),
      /followBody/
    );
  });

  test("audio lane pieces are saved apart from the head clips, without picture fields, and an empty lane is kept", () => {
    saveHeadRig(projectDir, null, "rodney", {
      key: "front",
      headSegments: [{ shotId: "h", inFrame: 1, outFrame: 5, start: 1, anchorX: 0.5, anchorY: 0.2, headScale: 1 }],
      audioSegments: [
        { shotId: "talk_1", inFrame: 3, outFrame: 40, start: 7, speed: 2, reverse: true, anchorX: 0.9, bodyInFront: true },
        { shotId: "talk_2", inFrame: 1, outFrame: 10, start: 50, speed: 1 },
      ],
    });
    let rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.deepEqual(rig.audioSegments[0], { shotId: "talk_1", inFrame: 3, outFrame: 40, start: 7, speed: 2, reverse: true });
    assert.deepEqual(rig.audioSegments[1], { shotId: "talk_2", inFrame: 1, outFrame: 10, start: 50 });
    assert.equal(rig.headSegments.length, 1);

    saveHeadRig(projectDir, null, "rodney", { key: "front", headSegments: rig.headSegments, audioSegments: [] });
    rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.deepEqual(rig.audioSegments, []);

    saveHeadRig(projectDir, null, "rodney", { key: "front", headSegments: rig.headSegments });
    rig = loadHeadRig(projectDir, null, "rodney").rigs.front;
    assert.equal("audioSegments" in rig, false);

    assert.throws(
      () => saveHeadRig(projectDir, null, "rodney", { key: "front", audioSegments: [{ shotId: "x", inFrame: 5, outFrame: 2, start: 1 }] }),
      /outFrame/
    );
  });
});
