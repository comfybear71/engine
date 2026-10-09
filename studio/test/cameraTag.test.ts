import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildCameraTag,
  findInsertAfterLine,
  insertLineAfter,
  normalizeOver,
  type CameraMoveForm,
} from "../lib/cameraTag.ts";

function form(partial: Partial<CameraMoveForm>): CameraMoveForm {
  return {
    zoom: "",
    pan: "",
    tilt: "",
    to: "",
    reset: false,
    over: "2s",
    ease: "linear",
    ...partial,
  };
}

describe("buildCameraTag", () => {
  test("builds a zoom move and normalizes over", () => {
    const result = buildCameraTag(form({ zoom: "1.3", over: "8" }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.tag, "[Camera: zoom=1.3 over=8s]");
  });

  test("includes ease=inout only when selected", () => {
    const linear = buildCameraTag(form({ pan: "960,540", ease: "linear" }));
    const inout = buildCameraTag(form({ pan: "960,540", ease: "inout" }));
    assert.equal(linear.ok, true);
    assert.equal(inout.ok, true);
    if (linear.ok) assert.equal(linear.tag, "[Camera: pan=960,540 over=2s]");
    if (inout.ok) assert.equal(inout.tag, "[Camera: pan=960,540 over=2s ease=inout]");
  });

  test("reset cannot mix with a target", () => {
    const mixed = buildCameraTag(form({ reset: true, zoom: "1.2" }));
    assert.equal(mixed.ok, false);
    if (!mixed.ok) assert.match(mixed.error, /reset cannot combine/);
    const ok = buildCameraTag(form({ reset: true, over: "1s" }));
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.tag, "[Camera: reset over=1s]");
  });

  test("rejects to+pan and missing target", () => {
    assert.equal(buildCameraTag(form({ to: "960,820", pan: "10,10" })).ok, false);
    assert.equal(buildCameraTag(form({})).ok, false);
    assert.equal(buildCameraTag(form({ zoom: "1.2", over: "" })).ok, false);
  });
});

describe("insertLineAfter", () => {
  test("inserts after a 1-based line", () => {
    const next = insertLineAfter("a\nb\nc", 2, "[Camera: zoom=1.2 over=2s]");
    assert.equal(next, "a\nb\n[Camera: zoom=1.2 over=2s]\nc");
  });

  test("findInsertAfterLine uses playhead line, else the scene end", () => {
    const script = ["[Scene: Intro]", "Alice: Hi.", "[Scene: Next]", "Bob: Bye."].join("\n");
    assert.equal(findInsertAfterLine(script, 2, "intro"), 2);
    assert.equal(findInsertAfterLine(script, null, "intro"), 2);
    assert.equal(findInsertAfterLine(script, null, "next"), 4);
  });
});

describe("normalizeOver", () => {
  test("requires a positive duration", () => {
    assert.equal(normalizeOver("2s"), "2s");
    assert.equal(normalizeOver("0.5"), "0.5s");
    assert.equal(normalizeOver("0"), null);
    assert.equal(normalizeOver(""), null);
  });
});
