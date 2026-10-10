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
    assert.equal(clip1.estimated, true);
    assert.ok(clip1.estimated_duration_seconds > 0);
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

describe("character.json pass-through", () => {
  test("child parent and pivot from character.json are copied onto the layer", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]"].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    const arm = alice.children.find((c) => c.id === "right_arm");
    const forearm = alice.children.find((c) => c.id === "forearm");
    assert.equal(arm.pivot, "top-center");
    assert.equal(forearm.parent, "right_arm");
    assert.equal(forearm.pivot, "top-center");
  });

  test("blank base asset + slots.body is a valid body-as-slot character", async () => {
    const billDir = path.join(fixture.globalAssetsDir, "characters", "bill");
    fixture.writePng(path.join(billDir, "blank.png"));
    fixture.writePng(path.join(billDir, "body", "stand.png"));
    fixture.writePng(path.join(billDir, "body", "ws01.png"));
    fixture.writePng(path.join(billDir, "body", "ws02.png"));
    fixture.writeJson(path.join(billDir, "character.json"), {
      id: "bill",
      display_name: "Bill",
      aliases: ["Bill"],
      asset: "blank.png",
      z: 10,
      default_scale: 1.0,
      slots: {
        body: {
          offset: { x: 0, y: 0 },
          drawings_dir: "body",
          default_drawing: "stand",
          cycles: { walk_side: { drawings: ["ws01", "ws02"], fps: 12 } },
        },
        mouth: {
          offset: { x: 0, y: -10 },
          drawings_dir: "mouth",
          visible_when: { body: ["stand"] },
        },
      },
      children: [],
    });
    for (const shape of ["A", "B", "C", "D", "E", "F", "G", "H", "X"]) {
      fixture.writePng(path.join(billDir, "mouth", `${shape}.png`));
    }

    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Bill]", "[Action: Bill body=walk_side]"].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const bill = layersFor(timeline).find((l) => l.character_id === "bill");
    assert.ok(bill.asset.endsWith("blank.png"));
    assert.ok(bill.slots.body);
    const [kf] = bill.slots.body.keyframes.filter((k) => k.cycle);
    assert.deepEqual(kf.cycle, ["ws01", "ws02"]);
    assert.equal(kf.fps, 12);
  });
});

describe("[Move:] / [Pose:] / [Swing:] / cycle actions", () => {
  test("[Move] writes transform keyframes on the current layer and advances the clock", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Move: Alice to=right over=1s]",
      "Alice: After the walk.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const aliceLayers = layersFor(timeline).filter((l) => l.character_id === "alice");
    assert.equal(aliceLayers.length, 1);
    const alice = aliceLayers[0];
    assert.equal(alice.transform.x, 450); // opened at room_a left
    assert.ok(alice.transform_keyframes);
    const [start, end] = alice.transform_keyframes;
    assert.equal(start.frame, 0);
    assert.equal(start.x, 450);
    assert.equal(end.frame, 24);
    assert.equal(end.x, 550);
    assert.equal(alice.dialogue[0].start_frame, 24);
  });

  test("[Move wait=false] does not advance the cursor", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Move: Alice to=right over=1s wait=false]",
      "Alice: During the walk.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    assert.equal(alice.dialogue[0].start_frame, 0);
    assert.equal(alice.transform_keyframes[1].frame, 24);
  });

  test("bare flip in [Action: ...] does not swallow later slot assignments", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Action: Alice flip eyes=closed]",
    ].join("\n");
    const { timeline, warnings } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    assert.equal(alice.transform.flip_x, true);
    assert.equal(alice.slots.eyes.keyframes[0].drawing, "closed");
    assert.equal(
      warnings.filter((w) => /key=value/.test(w)).length,
      0,
      `unexpected swallowed-assignment warning: ${JSON.stringify(warnings)}`
    );
  });

  test("a forked layer carries the active drawing/cycle instead of resetting to default_drawing", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Action: Alice eyes=blink_loop right_hand=point]",
      "[Move: Alice to=right over=0.5s]",
      "[Action: Alice flip=true]",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const [first, second] = layersFor(timeline).filter((l) => l.character_id === "alice");
    assert.equal(first.slots.eyes.keyframes[0].cycle[0], "open");
    const secondEyes = second.slots.eyes.keyframes[0];
    // 0.5s at 24 fps, cycle fps 6: index = floor(12/24*6)%2 = 1 → "closed" first
    assert.ok(secondEyes.cycle, "layer 2 eyes should still be a cycle, not default_drawing");
    assert.deepEqual(secondEyes.cycle, ["closed", "open"]);
    assert.equal(secondEyes.fps, 6);
    assert.equal(secondEyes.frame, 0);
    const secondHand = second.children.find((c) => c.id === "right_arm").slots.right_hand.keyframes[0];
    assert.equal(secondHand.drawing, "point");
    assert.equal(second.transform.flip_x, true);
  });

  test("a note that contains key=value warns with the line number", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Action: Alice at=left hello eyes=closed]",
    ].join("\n");
    const { timeline, warnings } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    assert.equal(alice.slots.eyes.keyframes[0].drawing, "open"); // default; eyes=closed was in the note
    assert.ok(
      warnings.some((w) => /Line 4:/.test(w) && /eyes=closed/.test(w) && /ignored/.test(w)),
      `expected swallowed-assignment warning, got: ${JSON.stringify(warnings)}`
    );
  });

  test("[Action: flip] after [Move] starts the new layer at the moved-to position", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Move: Alice to=right over=1s]",
      "[Action: Alice flip]",
      "Alice: Now facing the other way.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const aliceLayers = layersFor(timeline).filter((l) => l.character_id === "alice");
    assert.equal(aliceLayers.length, 2);
    const [first, second] = aliceLayers;
    assert.equal(first.timing.end_frame, second.timing.start_frame);
    assert.equal(second.transform.x, 550); // room_a right, not the original left mark
    assert.equal(second.transform.y, 1000);
    assert.equal(second.transform.flip_x, true);
    assert.equal(first.transform.x, 450);
  });

  test("[Pose] after [Action: flip] does not rewrite the previous layer's rest pose", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Move: Alice to=right over=1s]",
      "[Action: Alice flip]",
      "[Pose: Alice right_arm=40 over=0.5s]",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const [first, second] = layersFor(timeline).filter((l) => l.character_id === "alice");
    const firstArm = first.children.find((c) => c.id === "right_arm");
    const secondArm = second.children.find((c) => c.id === "right_arm");
    assert.equal(firstArm.rotation_keyframes, undefined);
    assert.equal(firstArm.rotation || 0, 0);
    assert.equal(secondArm.rotation_keyframes[0].rotation, 0);
    assert.equal(secondArm.rotation_keyframes[1].rotation, 40);
    assert.equal(secondArm.rotation, 40);
  });

  test("[Pose] writes rotation keyframes from the current angle to the target", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Pose: Alice right_arm=40 over=0.5s ease=inout]",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    const arm = alice.children.find((c) => c.id === "right_arm");
    assert.ok(arm.rotation_keyframes);
    assert.equal(arm.rotation_keyframes.length, 2);
    assert.equal(arm.rotation_keyframes[0].frame, 0);
    assert.equal(arm.rotation_keyframes[0].rotation, 0);
    assert.equal(arm.rotation_keyframes[0].ease, "inout");
    assert.equal(arm.rotation_keyframes[1].frame, 12);
    assert.equal(arm.rotation_keyframes[1].rotation, 40);
    assert.equal(arm.rotation, 40);
  });

  test("[Swing] writes a full-period keyframe run that ends at the start angle", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Swing: Alice right_arm=30 period=1s for=1s]",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    const arm = alice.children.find((c) => c.id === "right_arm");
    const keys = arm.rotation_keyframes;
    assert.equal(keys.length, 5);
    assert.equal(keys[0].rotation, 0);
    assert.equal(keys[0].frame, 0);
    assert.equal(keys[1].rotation, 30);
    assert.equal(keys[1].ease, "inout");
    assert.equal(keys[2].rotation, 0);
    assert.equal(keys[3].rotation, -30);
    assert.equal(keys[4].rotation, 0);
    assert.equal(keys[4].frame, 24);
    assert.equal(arm.rotation, 0);
  });

  test("[Action] with a named cycle emits a cycle keyframe; a drawing name still works", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Action: Alice eyes=blink_loop]",
      "[Pause: 12]",
      "[Action: Alice eyes=closed]",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script);
    const alice = layersFor(timeline).find((l) => l.character_id === "alice");
    const keys = alice.slots.eyes.keyframes;
    const cycleKf = keys.find((k) => k.cycle);
    const drawingKf = keys.find((k) => k.drawing === "closed");
    assert.ok(cycleKf);
    assert.deepEqual(cycleKf.cycle, ["open", "closed"]);
    assert.equal(cycleKf.fps, 6);
    assert.ok(drawingKf);
    assert.equal(drawingKf.frame, 12);
  });
});

describe("line-numbered errors for motion / cycles", () => {
  test("unknown cycle cites the line and lists available cycles", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Action: Alice eyes=walk_side]"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) =>
        err instanceof ScriptError &&
        err.lineNumber === 4 &&
        /cycle "walk_side"/.test(err.message) &&
        /blink_loop/.test(err.message)
    );
  });

  test("unknown part on [Pose] cites the line and lists available parts", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Pose: Alice left_foot=20 over=1s]"].join(
      "\n"
    );
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) =>
        err instanceof ScriptError &&
        err.lineNumber === 4 &&
        /Unknown part "left_foot"/.test(err.message) &&
        /right_arm/.test(err.message)
    );
  });

  test("unknown mark on [Move] cites the line", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Move: Alice to=upstage over=1s]"].join(
      "\n"
    );
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) => err instanceof ScriptError && err.lineNumber === 4 && /Unknown mark "upstage"/.test(err.message)
    );
  });

  test("unknown character on [Move] cites the line", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Move: Zelda to=right over=1s]"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) => err instanceof ScriptError && err.lineNumber === 4 && /Unknown character "Zelda"/.test(err.message)
    );
  });

  test("bad numbers on [Move] / [Pose] cite the line", async () => {
    await assert.rejects(
      () =>
        parseScript(
          fixture.projectDir,
          fixture.globalAssetsDir,
          ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Move: Alice to=right over=nope]"].join("\n")
        ),
      (err) => err instanceof ScriptError && err.lineNumber === 4 && /Invalid over/.test(err.message)
    );
    await assert.rejects(
      () =>
        parseScript(
          fixture.projectDir,
          fixture.globalAssetsDir,
          ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Pose: Alice right_arm=forty over=1s]"].join("\n")
        ),
      (err) => err instanceof ScriptError && err.lineNumber === 4 && /Invalid Pose right_arm/.test(err.message)
    );
  });
});

describe("[Camera:]", () => {
  test("writes scene camera keyframes; wait=true advances the clock", async () => {
    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Camera: zoom=1.3 over=2s ease=inout]",
      "[Camera: pan=800,400 over=1s]",
      "[Camera: tilt=-40 over=0.5s]",
      "[Camera: to=1000,500 zoom=1.5 over=1s]",
      "[Camera: reset over=1s]",
      "Alice: After the cameras.",
    ].join("\n");
    const { timeline } = await parseScript(fixture.projectDir, fixture.globalAssetsDir, script, { fps: 24 });
    const scene = timeline.scenes[0];
    const keys = scene.camera.keyframes;
    assert.equal(keys.length, 6);
    assert.equal(keys[0].frame, 0);
    assert.equal(keys[0].x, 960);
    assert.equal(keys[0].y, 540);
    assert.equal(keys[0].zoom, 1);
    assert.equal(keys[0].ease, "inout");
    assert.equal(keys[1].frame, 48);
    assert.equal(keys[1].zoom, 1.3);
    assert.equal(keys[1].x, 960);
    assert.equal(keys[2].frame, 72);
    assert.equal(keys[2].x, 800);
    assert.equal(keys[2].y, 400);
    assert.equal(keys[2].zoom, 1.3);
    assert.equal(keys[3].frame, 84);
    assert.equal(keys[3].y, 360);
    assert.equal(keys[4].frame, 108);
    assert.equal(keys[4].x, 1000);
    assert.equal(keys[4].y, 500);
    assert.equal(keys[4].zoom, 1.5);
    assert.equal(keys[5].frame, 132);
    assert.equal(keys[5].x, 960);
    assert.equal(keys[5].y, 540);
    assert.equal(keys[5].zoom, 1);
    assert.equal(scene.layers[0].dialogue[0].start_frame, 132);

    const waitFalse = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Camera: zoom=1.3 over=1s wait=false]",
      "Alice: During the zoom.",
    ].join("\n");
    const during = await parseScript(fixture.projectDir, fixture.globalAssetsDir, waitFalse, { fps: 24 });
    assert.equal(during.timeline.scenes[0].layers[0].dialogue[0].start_frame, 0);
    assert.equal(during.timeline.scenes[0].camera.keyframes[1].frame, 24);
  });

  test("invalid [Camera:] args are line-numbered errors", async () => {
    await assert.rejects(
      () =>
        parseScript(
          fixture.projectDir,
          fixture.globalAssetsDir,
          ["[Scene: Intro]", "[Location: room_a]", "[Camera: zoom=1.3 over=nope]"].join("\n")
        ),
      (err) => err instanceof ScriptError && err.lineNumber === 3 && /Invalid over/.test(err.message)
    );
    await assert.rejects(
      () =>
        parseScript(
          fixture.projectDir,
          fixture.globalAssetsDir,
          ["[Scene: Intro]", "[Location: room_a]", "[Camera: wobble=1 over=1s]"].join("\n")
        ),
      (err) => err instanceof ScriptError && err.lineNumber === 3 && /Unknown \[Camera/.test(err.message)
    );
    await assert.rejects(
      () =>
        parseScript(
          fixture.projectDir,
          fixture.globalAssetsDir,
          ["[Scene: Intro]", "[Location: room_a]", "[Camera: reset zoom=1.2 over=1s]"].join("\n")
        ),
      (err) => err instanceof ScriptError && err.lineNumber === 3 && /cannot combine/.test(err.message)
    );
    await assert.rejects(
      () =>
        parseScript(
          fixture.projectDir,
          fixture.globalAssetsDir,
          ["[Scene: Intro]", "[Location: room_a]", "[Camera: pan=left over=1s]"].join("\n")
        ),
      (err) => err instanceof ScriptError && err.lineNumber === 3 && /Invalid pan/.test(err.message)
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

describe("prop layers", () => {
  test("declared props emit layers; [Prop:] moves/hides and [Layer:] changes z", async () => {
    const isolated = createFixtureLibrary();
    isolated.writePng(path.join(isolated.globalAssetsDir, "backgrounds", "room_a", "props", "letterbox.png"));
    isolated.writeJson(path.join(isolated.globalAssetsDir, "backgrounds", "room_a", "staging.json"), {
      marks: {
        centre: { x: 500, y: 1000, scale: 1.0 },
        left: { x: 450, y: 1000, scale: 1.0 },
        right: { x: 550, y: 1000, scale: 1.0 },
      },
      auto_order: ["left", "right"],
      props: {
        letterbox: {
          asset: "props/letterbox.png",
          x: 300,
          y: 1000,
          anchor: "bottom-centre",
          scale: 1.0,
          z: 5,
        },
      },
    });

    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Prop: letterbox at=right z=15]",
      "Alice: Walking past the box.",
      "[Layer: letterbox z=25]",
      "[Layer: Alice z=5]",
      "[Pause: 12]",
      "[Prop: letterbox hide]",
    ].join("\n");

    const { timeline, errors } = await parseScript(isolated.projectDir, isolated.globalAssetsDir, script);
    isolated.cleanup();

    assert.deepEqual(errors, []);
    const layers = layersFor(timeline);
    const aliceLayers = layers.filter((l) => l.character_id === "alice");
    const propLayers = layers.filter((l) => l.prop_id === "letterbox");

    assert.equal(aliceLayers.length, 2);
    assert.equal(aliceLayers[0].z, 10);
    assert.equal(aliceLayers[1].z, 5);
    assert.equal(aliceLayers[1].id, "alice_2");
    assert.equal(aliceLayers[0].timing.end_frame, aliceLayers[1].timing.start_frame);

    assert.equal(propLayers.length, 2);
    assert.equal(propLayers[0].character_id, undefined);
    assert.equal(propLayers[0].transform.x, 550); // room_a right
    assert.equal(propLayers[0].transform.y, 1000);
    assert.equal(propLayers[0].transform.anchor, "bottom-center");
    assert.equal(propLayers[0].z, 15);
    assert.equal(propLayers[0].asset, "../_global_assets/backgrounds/room_a/props/letterbox.png");
    assert.equal(propLayers[1].id, "letterbox_2");
    assert.equal(propLayers[1].z, 25);
    assert.equal(propLayers[0].timing.end_frame, propLayers[1].timing.start_frame);
    assert.ok(propLayers[1].timing.end_frame > propLayers[1].timing.start_frame);
  });

  test("lint/parse errors when a declared prop asset is missing", async () => {
    const isolated = createFixtureLibrary();
    isolated.writeJson(path.join(isolated.globalAssetsDir, "backgrounds", "room_a", "staging.json"), {
      marks: {
        centre: { x: 500, y: 1000, scale: 1.0 },
        left: { x: 450, y: 1000, scale: 1.0 },
        right: { x: 550, y: 1000, scale: 1.0 },
      },
      auto_order: ["left", "right"],
      props: {
        letterbox: { asset: "props/letterbox.png", x: 300, y: 1000, z: 5 },
      },
    });

    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]"].join("\n");
    await assert.rejects(
      () => parseScript(isolated.projectDir, isolated.globalAssetsDir, script),
      (err) =>
        err instanceof ScriptError &&
        err.lineNumber === 2 &&
        /Prop "letterbox" is missing asset "backgrounds\/room_a\/props\/letterbox.png"/.test(err.message)
    );
    isolated.cleanup();
  });
});

describe("[Audio: Name file=<label>]", () => {
  test("places the imported WAV as dialogue, copies words, and advances by real duration", async () => {
    const audioDir = path.join(fixture.projectDir, "audio", "monologue");
    wav.writeSilentWav(path.join(audioDir, "001_alice.wav"), 2.0);
    fs.writeFileSync(
      path.join(audioDir, "001_alice.words.json"),
      JSON.stringify([
        { word: "Hello", start: 0.0, end: 0.4 },
        { word: "there.", start: 0.4, end: 0.8 },
        { word: "Okay", start: 1.6, end: 1.9 },
      ])
    );

    const script = [
      "[Scene: Intro]",
      "[Location: room_a]",
      "[Cast: Alice]",
      "[Audio: Alice file=monologue]",
      "Alice: After the take.",
    ].join("\n");
    const { timeline, lines, laneEvents } = await parseScript(
      fixture.projectDir,
      fixture.globalAssetsDir,
      script,
      { fps: 24 }
    );

    const [clip] = layersFor(timeline)[0].dialogue;
    assert.equal(clip.audio, "audio/monologue/001_alice.wav");
    assert.equal(clip.start_frame, 0);
    assert.equal(clip.text, "Hello there. Okay");
    assert.equal(clip.words.length, 3);
    assert.equal(clip.estimated, undefined);
    assert.ok(layersFor(timeline)[0].dialogue[1].start_frame >= 48);

    assert.equal(lines[0].status, "ok");
    assert.equal(lines[0].source, "import");
    assert.equal(lines[0].audio_path, "audio/monologue/001_alice.wav");
    assert.equal(lines[0].words_path, "audio/monologue/001_alice.words.json");

    const dialogueLanes = laneEvents.filter((e) => e.lane === "dialogue");
    assert.equal(dialogueLanes.length, 3);
    assert.match(dialogueLanes[0].label, /Hello there\./);
    assert.match(dialogueLanes[1].label, /Okay/);
    assert.match(dialogueLanes[2].label, /After the take/);

    const audioLanes = laneEvents.filter((e) => e.lane === "audio");
    assert.equal(audioLanes[0].endFrame - audioLanes[0].startFrame, 48);

    fs.rmSync(path.join(fixture.projectDir, "audio"), { recursive: true, force: true });
  });

  test("missing imported WAV is a line-numbered error (no estimate)", async () => {
    const script = ["[Scene: Intro]", "[Location: room_a]", "[Cast: Alice]", "[Audio: Alice file=missing]"].join("\n");
    await assert.rejects(
      () => parseScript(fixture.projectDir, fixture.globalAssetsDir, script),
      (err) =>
        err instanceof ScriptError &&
        err.lineNumber === 4 &&
        /No imported audio "missing"/.test(err.message) &&
        /import-audio/.test(err.message)
    );
  });
});
