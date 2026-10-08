"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { tokenize } = require("../src/parser/tokenizer");
const { ScriptError } = require("../src/parser/errors");

describe("tokenizer", () => {
  test("parses each known tag kind", () => {
    const tokens = tokenize(
      [
        "[Scene: Kitchen]",
        "[Location: corridor]",
        "[Cast: Alice, Bob]",
        "[Action: Alice at=left]",
        "[Pause: 12]",
        "Alice: Hello there.",
      ].join("\n")
    );
    assert.deepEqual(
      tokens.map((t) => t.kind),
      ["scene", "location", "cast", "action", "pause", "dialogue"]
    );
  });

  test("strips full-line and trailing comments (# and //)", () => {
    const tokens = tokenize(
      ["# a full line comment", "[Scene: X] # trailing comment", "// another full comment", "Alice: Hi // trailing"].join("\n")
    );
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].kind, "scene");
    assert.equal(tokens[0].body, "X");
    assert.equal(tokens[1].text, "Hi");
  });

  test("ignores decorative === lines", () => {
    const tokens = tokenize(["===", "[Scene: X]", "====="].join("\n"));
    assert.deepEqual(
      tokens.map((t) => t.kind),
      ["decorative", "scene", "decorative"]
    );
  });

  test("tracks 1-based line numbers through blank lines and comments", () => {
    const tokens = tokenize(["", "# comment", "[Scene: X]", "", "Alice: Hi"].join("\n"));
    assert.equal(tokens[0].lineNumber, 3);
    assert.equal(tokens[1].lineNumber, 5);
  });

  test("dialogue line captures character name and text", () => {
    const [token] = tokenize("Hicks: Where's the rent money, Dana?");
    assert.equal(token.kind, "dialogue");
    assert.equal(token.character, "Hicks");
    assert.equal(token.text, "Where's the rent money, Dana?");
  });

  test("unknown bracket tag throws a line-numbered ScriptError", () => {
    assert.throws(
      () => tokenize("[Foo: bar]"),
      (err) => err instanceof ScriptError && err.lineNumber === 1 && /Unknown tag/.test(err.message)
    );
  });

  test("malformed bracket tag (no closing bracket) throws a line-numbered error", () => {
    assert.throws(
      () => tokenize("[Scene: unterminated"),
      (err) => err instanceof ScriptError && err.lineNumber === 1
    );
  });

  test("unrecognized line throws a line-numbered error", () => {
    assert.throws(
      () => tokenize("this is not a valid line at all!!"),
      (err) => err instanceof ScriptError && err.lineNumber === 1 && /Unrecognized line/.test(err.message)
    );
  });
});
