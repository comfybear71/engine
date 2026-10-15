"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadHeadRig, saveHeadStandard, clearHeadStandard } = require("../src/characterLocal");

describe("character head standard", () => {
  let root;
  let projectDir;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "head-standard-"));
    projectDir = path.join(root, "proj");
    const dir = path.join(projectDir, "characters", "rodney");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify({ id: "rodney", display_name: "Rodney" }));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("round-trips through the head rig load", () => {
    assert.equal(loadHeadRig(projectDir, null, "rodney").standard, null);
    const saved = saveHeadStandard(projectDir, null, "rodney", {
      height: 0.21,
      centerX: 0.5,
      centerY: 0.12,
      views: { left_34: 0.96, back: 1 },
    });
    assert.deepEqual(saved.standard, { height: 0.21, centerX: 0.5, centerY: 0.12, views: { left_34: 0.96 } });
    assert.deepEqual(loadHeadRig(projectDir, null, "rodney").standard, saved.standard);
    assert.equal(clearHeadStandard(projectDir, null, "rodney").standard, null);
    assert.equal(loadHeadRig(projectDir, null, "rodney").standard, null);
  });

  test("rejects nonsense", () => {
    assert.throws(() => saveHeadStandard(projectDir, null, "rodney", { height: 9, centerX: 0.5, centerY: 0.1 }), /height/);
    assert.throws(
      () => saveHeadStandard(projectDir, null, "rodney", { height: 0.2, centerX: 0.5, centerY: 0.1, views: { "../x": 1.1 } }),
      /Invalid view key/
    );
  });
});
