"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseActionTag,
  noteHasKeyValue,
  parseCastList,
  parsePauseValue,
  parseSecondsSpec,
  parseEaseValue,
  parseWaitValue,
  parseNumberValue,
  parseXyPair,
} = require("../src/parser/actionTag");
const { ScriptError } = require("../src/parser/errors");

describe("parseActionTag", () => {
  test("parses character + multiple key=value pairs", () => {
    const { character, kv, note } = parseActionTag("Hicks at=left right_hand=point eyes=furious");
    assert.equal(character, "Hicks");
    assert.deepEqual(kv, { at: "left", right_hand: "point", eyes: "furious" });
    assert.equal(note, "");
  });

  test("free text after key=value pairs becomes a note, not an error", () => {
    const { character, kv, note } = parseActionTag("Hicks at=left storms off in a huff");
    assert.equal(character, "Hicks");
    assert.deepEqual(kv, { at: "left" });
    assert.equal(note, "storms off in a huff");
  });

  test("bare 'flip' flag sets flip=true without needing a value", () => {
    const { kv } = parseActionTag("Hicks flip");
    assert.equal(kv.flip, "true");
  });

  test("bare flip does not swallow later key=value tokens", () => {
    const { kv, note } = parseActionTag("BillWalk flip body=walk_side eyes=furious");
    assert.equal(kv.flip, "true");
    assert.equal(kv.body, "walk_side");
    assert.equal(kv.eyes, "furious");
    assert.equal(note, "");
  });

  test("bare flip can sit between key=value tokens", () => {
    const { kv, note } = parseActionTag("Hicks at=left flip body=walk_side storms off");
    assert.deepEqual(kv, { at: "left", flip: "true", body: "walk_side" });
    assert.equal(note, "storms off");
    assert.equal(noteHasKeyValue(note), false);
  });

  test("noteHasKeyValue is true when free text contains a key=value token", () => {
    const { note } = parseActionTag("Hicks at=left hello body=walk_side");
    assert.equal(note, "hello body=walk_side");
    assert.equal(noteHasKeyValue(note), true);
  });

  test("scale= and z= are parsed as plain key/value like any slot", () => {
    const { kv } = parseActionTag("Hicks scale=1.4 z=12");
    assert.equal(kv.scale, "1.4");
    assert.equal(kv.z, "12");
  });

  test("character name alone with no key=value pairs", () => {
    const { character, kv, note } = parseActionTag("Hicks");
    assert.equal(character, "Hicks");
    assert.deepEqual(kv, {});
    assert.equal(note, "");
  });
});

describe("parseCastList", () => {
  test("splits and trims a comma-separated list", () => {
    assert.deepEqual(parseCastList("Hicks, Dana ,  Eli"), ["Hicks", "Dana", "Eli"]);
  });

  test("drops empty entries from trailing commas", () => {
    assert.deepEqual(parseCastList("Hicks, Dana,"), ["Hicks", "Dana"]);
  });
});

describe("parsePauseValue", () => {
  test("plain integer is frames", () => {
    assert.deepEqual(parsePauseValue("12", 1), { frames: 12 });
  });

  test("Ns is seconds", () => {
    assert.deepEqual(parsePauseValue("0.5s", 1), { seconds: 0.5 });
  });

  test("invalid value throws a line-numbered ScriptError", () => {
    assert.throws(() => parsePauseValue("abc", 7), (err) => err instanceof ScriptError && err.lineNumber === 7);
  });
});

describe("animation tag value parsers", () => {
  test("parseSecondsSpec accepts Ns", () => {
    assert.equal(parseSecondsSpec("1s", 1, "over"), 1);
    assert.equal(parseSecondsSpec("0.5s", 1, "over"), 0.5);
  });

  test("parseSecondsSpec rejects bad values with a line number", () => {
    assert.throws(() => parseSecondsSpec("abc", 4, "over"), (err) => err instanceof ScriptError && err.lineNumber === 4);
    assert.throws(() => parseSecondsSpec("0s", 4, "over"), (err) => err instanceof ScriptError && err.lineNumber === 4);
  });

  test("parseEaseValue / parseWaitValue / parseXyPair", () => {
    assert.equal(parseEaseValue(undefined, 1), "linear");
    assert.equal(parseEaseValue("inout", 1), "inout");
    assert.throws(() => parseEaseValue("bounce", 2), (err) => err instanceof ScriptError && err.lineNumber === 2);
    assert.equal(parseWaitValue(undefined, 1), true);
    assert.equal(parseWaitValue("false", 1), false);
    assert.throws(() => parseWaitValue("maybe", 3), (err) => err instanceof ScriptError && err.lineNumber === 3);
    assert.deepEqual(parseXyPair("400,1080"), { x: 400, y: 1080 });
    assert.equal(parseXyPair("right"), null);
    assert.equal(parseNumberValue("-20", 1, "right_arm"), -20);
  });
});
