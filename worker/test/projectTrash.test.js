"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { findSoundUsages, trashAsset } = require("../src/projectTrash");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("project asset trash", () => {
  test("unused sounds move to .trash and used sounds report the script", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-trash-"));
    write(path.join(root, "script_act1.txt"), "[Scene: One]\n[Audio: Rodney file=rodney_rude_japs_and_stuff_x5h5nplk6_q]\n");
    write(path.join(root, "audio", "rodney_rude_japs_and_stuff_x5h5nplk6_q", "001_rodney.wav"), "wav");
    write(path.join(root, "audio", "big_red_rude_truck", "001_rodney.wav"), "wav");

    const used = findSoundUsages(root, "rodney_rude_japs_and_stuff_x5h5nplk6_q");
    assert.equal(used[0].script, "script_act1.txt");
    assert.equal(findSoundUsages(root, "big_red_rude_truck").length, 0);

    assert.throws(
      () => trashAsset(root, null, { kind: "sound", label: "rodney_rude_japs_and_stuff_x5h5nplk6_q", confirm: true }),
      (err) => err.code === "EUSED" && /script_act1\.txt/.test(err.message)
    );

    const result = trashAsset(root, null, { kind: "sound", label: "big_red_rude_truck", confirm: true });
    assert.match(result.trash, /^\.trash\//);
    assert.equal(fs.existsSync(path.join(root, "audio", "big_red_rude_truck")), false);
    assert.equal(fs.existsSync(path.join(root, result.moved[0].to)), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
