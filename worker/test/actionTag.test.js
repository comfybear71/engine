"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { parseActionTag, parseCastList, parsePauseValue } = require("../src/parser/actionTag");
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
