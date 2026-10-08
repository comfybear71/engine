"use strict";

const { test, describe, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const wav = require("./helpers/wav");

const { parseScript } = require("../src/parser/scriptParser");
const { ScriptError } = require("../src/parser/errors");
const { createFixtureLibrary } = require("./helpers/fixtureLibrary");

const fixture = createFixtureLibrary();
after(() => fixture.cleanup());

function layersFor(timeline, sceneIndex = 0) {
  return timeline.scenes[sceneIndex].layers;
}

describe("basic structure", () => {
  test("[Cast: ...] auto-assigns marks by cast order, one layer per character", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice, Bob]", "Alice: Hi.", "Bob: Hello."].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);

    const layers = layersFor(timeline);
    assert.equal(layers.length, 2);
    const alice = layers.find((l) => l.character_id === "alice");
    const bob = layers.find((l) => l.character_id === "bob");
    assert.equal(alice.transform.x, 450); // room_a "left"
    assert.equal(bob.transform.x, 550); // room_a "right"
  });

  test("multiple dialogue lines for one character never create duplicate layers", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "Alice: One.",
      "Alice: Two.",
      "Alice: Three.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);

    const layers = layersFor(timeline);
    assert.equal(layers.length, 1);
    assert.equal(layers[0].dialogue.length, 3);
  });

  test("a character speaking without being in [Cast: ...] is added automatically, with a warning", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "Alice: Surprise!"].join("\n");
    const { timeline, warnings } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    assert.equal(layersFor(timeline).length, 1);
    assert.ok(warnings.some((w) => /not in \[Cast/.test(w)));
  });
});

describe("sequential timing", () => {
  test("estimated durations (no audio file yet) still sequence lines back-to-back", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: One two three four five.", "Alice: Six."].join(
      "\n"
    );
    const { timeline, lines } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const [clip1, clip2] = layersFor(timeline)[0].dialogue;

    assert.equal(clip1.start_frame, 0);
    assert.ok(clip2.start_frame > clip1.start_frame);
    assert.equal(lines[0].status, "missing");
    assert.ok(lines[0].estimated_duration_seconds > 0);
  });

  test("a real audio file on disk is used (real ffprobe duration) instead of an estimate", async () => {
    const sceneId = "intro";
    const audioPath = path.join(fixture.projectDir, "audio", sceneId, "001_alice.wav");
    wav.writeSilentWav(audioPath, 1.25);

    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: This line has real audio."].join("\n");
    const { lines } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);

    assert.equal(lines[0].status, "ok");
    assert.equal(lines[0].estimated_duration_seconds, undefined);

    fs.rmSync(path.join(fixture.projectDir, "audio"), { recursive: true, force: true });
  });

  test("[Pause: N] advances the cursor without creating a dialogue clip", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "Alice: One.",
      "[Pause: 48]",
      "Alice: Two.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const [clip1, clip2] = layersFor(timeline)[0].dialogue;
    // clip1 duration (estimated) + an explicit 48-frame pause must separate them.
    assert.ok(clip2.start_frame >= clip1.start_frame + 48);
  });

  test("[Pause: 0.5s] converts seconds to frames at the timeline's fps", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "Alice: One.",
      "[Pause: 0.5s]",
      "Alice: Two.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const [clip1, clip2] = layersFor(timeline)[0].dialogue;
    assert.ok(clip2.start_frame >= clip1.start_frame + 12); // 0.5s @ 24fps = 12 frames
  });
});

describe("mark resolution order", () => {
  test("same cast order resolves to different positions in different locations", async () => {
    const scriptFor = (location) =>
      ["[Scene: Intro]", `[Location: ${location}]`, "[Cast: Alice, Bob]"].join("\n");

    const { timeline: room_aTimeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, scriptFor("room_a"));
    const { timeline: room_bTimeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, scriptFor("room_b"));

    const aliceA = layersFor(room_aTimeline).find((l) => l.character_id === "alice");
    const aliceB = layersFor(room_bTimeline).find((l) => l.character_id === "alice");
    assert.notEqual(aliceA.transform.x, aliceB.transform.x);
    assert.notEqual(aliceA.transform.scale, aliceB.transform.scale);
  });

  test("explicit [Action: ... at=mark] overrides the auto-assigned mark", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice, Bob]", "[Action: Alice at=right]"].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    assert.equal(alice.transform.x, 550); // room_a "right", not the auto-assigned "left"
  });

  test("explicit scale= on the Action tag overrides the mark's own scale", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice scale=2.5]"].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    assert.equal(alice.transform.scale, 2.5);
  });

  test("mark's own scale is used when the Action tag doesn't set one", async () => {
    const script = ["[Scene: Intro]", "[Location: room_b]", "[Cast: Alice]", "[Action: Alice at=right]"].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    assert.equal(alice.transform.scale, 0.7); // room_b "right" mark's own scale
  });

  test("character.json default_scale is used when neither the Action tag nor the mark specify one", async () => {
    // room_a's "centre" mark has no scale of its own in the fixture.
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice at=centre]"].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    assert.equal(alice.transform.scale, 1.0); // alice's character.json default_scale
  });

  test("a mark only present in the global defaults (not the location) still resolves", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice at=off_left]"].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    assert.equal(alice.transform.x, -100); // from staging_defaults.json, not room_a's own staging.json
  });
});

describe("slot keyframes from [Action: ...]", () => {
  test("a slot change becomes a held-until-changed keyframe at the current frame", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "Alice: First line here now.",
      "[Action: Alice eyes=closed]",
      "Alice: Second line here now.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    const eyesKeyframes = alice.slots.eyes.keyframes;
    assert.equal(eyesKeyframes[0].drawing, "open"); // default at frame 0
    assert.equal(eyesKeyframes[1].drawing, "closed");
    assert.ok(eyesKeyframes[1].frame > 0);
  });

  test("a rig child's slot (right_hand on alice's arm) is set via Action and ends up on the child", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice right_hand=point]"].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    const arm = alice.children.find((c) => c.id === "right_arm");
    assert.equal(arm.slots.right_hand.keyframes[0].drawing, "point");
  });

  test("the mouth slot cannot be set via [Action: ...] (it's dialogue-driven)", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice mouth=A]"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) => err instanceof ScriptError && /driven by dialogue/.test(err.message)
    );
  });
});

describe("repositioning mid-scene", () => {
  test("[Action: ... at=...] after dialogue has started creates a new back-to-back layer segment", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "Alice: First from the left.",
      "[Action: Alice at=right]",
      "Alice: Second from the right.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const aliceLayers = layersFor(timeline).filter((l) => l.character_id === "alice");
    assert.equal(aliceLayers.length, 2);
    const [first, second] = aliceLayers;
    assert.equal(first.id, "alice");
    assert.equal(second.id, "alice_2");
    assert.equal(first.timing.end_frame, second.timing.start_frame);
    assert.notEqual(first.transform.x, second.transform.x);
    assert.equal(first.dialogue.length, 1);
    assert.equal(second.dialogue.length, 1);
  });

  test("repeating the same mark does NOT create a redundant new segment", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Action: Alice at=left]",
      "Alice: Still here.",
      "[Action: Alice at=left]",
      "Alice: Still here too.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const aliceLayers = layersFor(timeline).filter((l) => l.character_id === "alice");
    assert.equal(aliceLayers.length, 1);
    assert.equal(aliceLayers[0].dialogue.length, 2);
  });
});

describe("line-numbered errors", () => {
  test("unknown character in dialogue cites the line number and lists known characters", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Zelda: Who am I?"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) => err instanceof ScriptError && err.lineNumber === 4 && /Unknown character "Zelda"/.test(err.message) && /Alice/.test(err.message)
    );
  });

  test("unknown drawing cites the line number and lists available drawings", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice right_hand=pointt]"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) =>
        err instanceof ScriptError &&
        err.lineNumber === 4 &&
        /no right_hand drawing "pointt"/.test(err.message) &&
        /fist/.test(err.message) &&
        /point/.test(err.message)
    );
  });

  test("unknown mark cites the line number and lists available marks", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice at=upstage]"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) => err instanceof ScriptError && err.lineNumber === 4 && /Unknown mark "upstage"/.test(err.message)
    );
  });

  test("unknown location cites available locations", async () => {
    const script = ["[Scene: Intro]", "[Location: nowhere]"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) => err instanceof ScriptError && err.lineNumber === 2 && /Unknown location/.test(err.message)
    );
  });

  test("unknown slot name lists what is available", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice left_foot=up]"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) => err instanceof ScriptError && /no "left_foot" slot/.test(err.message)
    );
  });
});

describe("lines.json manifest shape", () => {
  test("includes scene, line number, character, text, audio/cues paths and status", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "Alice: Hello there friend."].join("\n");
    const { lines } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);

    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.equal(line.scene_id, "intro");
    assert.equal(line.line_number, 1);
    assert.equal(line.character, "alice");
    assert.equal(line.text, "Hello there friend.");
    assert.equal(line.audio_path, "audio/intro/001_alice.wav");
    assert.equal(line.cues_path, "audio/intro/001_alice.wav.rhubarb.json");
    assert.equal(line.status, "missing");
    assert.ok("voice_id" in line);
  });
});
