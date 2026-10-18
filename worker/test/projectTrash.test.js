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

  test("characters move to .trash, leave the library, and warn when a script names them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-trash-"));
    try {
      write(path.join(root, "script_act1.txt"), "[Scene: One]\nColonel Klink: Hogan!\n");
      write(path.join(root, "library.json"), JSON.stringify({ characters: ["colonel_klink", "spare"], backgrounds: [] }));
      write(
        path.join(root, "characters", "colonel_klink", "character.json"),
        JSON.stringify({ id: "colonel_klink", display_name: "Colonel Klink", aliases: ["Colonel Klink"], slots: {} })
      );
      write(path.join(root, "characters", "colonel_klink", "_reference", "full.png"), "png");
      write(
        path.join(root, "characters", "spare", "character.json"),
        JSON.stringify({ id: "spare", display_name: "Spare", slots: {} })
      );

      assert.throws(
        () => trashAsset(root, null, { kind: "character", id: "colonel_klink", confirm: true }),
        (err) => err.code === "EUSED" && /script_act1\.txt/.test(err.message)
      );
      assert.equal(fs.existsSync(path.join(root, "characters", "colonel_klink")), true);

      const spare = trashAsset(root, null, { kind: "character", id: "spare", confirm: true });
      assert.equal(fs.existsSync(path.join(root, "characters", "spare")), false);
      assert.equal(fs.existsSync(path.join(root, spare.moved[0].to, "character.json")), true);

      trashAsset(root, null, { kind: "character", id: "colonel_klink", confirm: true, force: true });
      assert.equal(fs.existsSync(path.join(root, "characters", "colonel_klink")), false);
      const library = JSON.parse(fs.readFileSync(path.join(root, "library.json"), "utf8"));
      assert.deepEqual(library.characters, []);

      assert.throws(
        () => trashAsset(root, null, { kind: "character", id: "nobody", confirm: true }),
        (err) => err.code === "ELOCKED"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
