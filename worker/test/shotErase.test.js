"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { listErasedFrames, eraseShotFrames, restoreShotFrames } = require("../src/shots");
const { resolvePythonBin, PYTHON_DIR } = require("../src/pythonRuntime");

const python = resolvePythonBin();

function py(code) {
  const res = spawnSync(python, ["-c", code], { cwd: PYTHON_DIR, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

describe("erase parts of a shot's frames", () => {
  let root;
  let projectDir;
  let shot;
  let maskB64;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shot-erase-"));
    projectDir = path.join(root, "proj");
    const charDir = path.join(projectDir, "characters", "rodney");
    shot = path.join(charDir, "shots", "clip_1");
    fs.mkdirSync(path.join(shot, "cut"), { recursive: true });
    fs.mkdirSync(path.join(shot, "thumb"), { recursive: true });
    fs.writeFileSync(path.join(charDir, "character.json"), JSON.stringify({ id: "rodney", display_name: "Rodney" }));
    fs.writeFileSync(path.join(shot, "shot.json"), JSON.stringify({ id: "clip_1", fps: 24, frameCount: 3, status: "ready" }));
    py(
      `import cv2, numpy as np\nfor i in (1,2,3):\n    a=np.zeros((40,60,4),np.uint8); a[:,:,:3]=(10,20,200); a[:,:,3]=255\n    cv2.imwrite(r'${shot.replace(/\\/g, "\\\\")}/cut/f_000%d.png' % i, a)`
    );
    maskB64 = py(
      "import cv2, numpy as np, base64\nm=np.zeros((40,60),np.uint8); m[:,:30]=255\nprint(base64.b64encode(cv2.imencode('.png',m)[1].tobytes()).decode())"
    );
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const alphaAt = (frame, x) =>
    Number(
      py(
        `import cv2\nprint(cv2.imread(r'${shot.replace(/\\/g, "\\\\")}/cut/f_000${frame}.png', cv2.IMREAD_UNCHANGED)[20,${x},3])`
      )
    );

  test("erases the chosen frames only, lists them, and restores them", async () => {
    assert.deepEqual(listErasedFrames(projectDir, "rodney", "clip_1"), []);
    const res = await eraseShotFrames(projectDir, "rodney", "clip_1", { frames: [2, 3], mask: `data:image/png;base64,${maskB64}` });
    assert.deepEqual(res.frames, [2, 3]);
    assert.equal(alphaAt(2, 10), 0);
    assert.equal(alphaAt(2, 50), 255);
    assert.equal(alphaAt(3, 10), 0);
    assert.equal(alphaAt(1, 10), 255);

    const one = await restoreShotFrames(projectDir, "rodney", "clip_1", { frames: [2] });
    assert.deepEqual(one.frames, [3]);
    assert.equal(alphaAt(2, 10), 255);
    assert.equal(alphaAt(3, 10), 0);

    const all = await restoreShotFrames(projectDir, "rodney", "clip_1", {});
    assert.deepEqual(all.frames, []);
    assert.equal(alphaAt(3, 10), 255);
  });

  test("rejects a mask that is not a PNG, and frames that do not exist", async () => {
    await assert.rejects(
      eraseShotFrames(projectDir, "rodney", "clip_1", { frames: [1], mask: Buffer.from("not a png at all, sorry").toString("base64") }),
      /PNG/
    );
    await assert.rejects(eraseShotFrames(projectDir, "rodney", "clip_1", { frames: [9], mask: maskB64 }), /Frame 9/);
    await assert.rejects(eraseShotFrames(projectDir, "rodney", "clip_1", { frames: [], mask: maskB64 }), /frames/);
    assert.deepEqual(listErasedFrames(projectDir, "rodney", "clip_1"), []);
  });
});
