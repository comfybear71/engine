import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addSceneToScript, nextSceneName, sceneCastNames } from "../lib/newScene.ts";

const two = [
  "# comment",
  "===",
  "[Scene: One]",
  "[Location: bedroom]",
  "[Cast: Hicks, Dana]",
  "Hicks: Hi.",
  "",
  "===",
  "[Scene: Two]",
  "[Location: corridor]",
  "Dana: Bye.",
  "",
].join("\n");

describe("new scene", () => {
  test("is inserted after the chosen scene, before the next one", () => {
    const result = addSceneToScript(two, { afterSceneId: "one", name: "Bar", location: "bedroom", cast: ["Klink"] });
    assert.ok(result);
    assert.equal(result.sceneId, "bar");
    const lines = result.script.split("\n");
    const bar = lines.indexOf("[Scene: Bar]");
    assert.ok(bar > lines.indexOf("Hicks: Hi."));
    assert.ok(bar < lines.indexOf("[Scene: Two]"));
    assert.equal(lines[bar + 1], "[Location: bedroom]");
    assert.equal(lines[bar + 2], "[Cast: Klink]");
    assert.equal(lines[bar - 1], "");
    assert.equal(lines[lines.indexOf("[Scene: Two]") - 1], "===");
  });

  test("goes at the end after the last scene and keeps the file ending", () => {
    const result = addSceneToScript(two, { afterSceneId: "two", name: "Last", location: "corridor", cast: [] });
    assert.ok(result);
    assert.match(result.script, /Dana: Bye\.\n\n\[Scene: Last\]\n\[Location: corridor\]\n$/);
    assert.doesNotMatch(result.script, /\[Cast:\s*\]/);
  });

  test("a clashing name gets a number so the id matches the parser", () => {
    const result = addSceneToScript(two, { afterSceneId: "one", name: "two", location: "bedroom", cast: [] });
    assert.equal(result?.name, "two 2");
    assert.equal(result?.sceneId, "two_2");
  });

  test("needs a location; reads the cast of a scene; suggests a name", () => {
    assert.equal(addSceneToScript(two, { afterSceneId: "one", name: "X", location: " ", cast: [] }), null);
    assert.deepEqual(sceneCastNames(two, "one"), ["Hicks", "Dana"]);
    assert.deepEqual(sceneCastNames(two, "two"), []);
    assert.equal(nextSceneName(two), "Scene 3");
  });
});
