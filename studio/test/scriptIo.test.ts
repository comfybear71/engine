import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { requireScriptName, withScript } from "../lib/worker.ts";

describe("script request helpers", () => {
  test("withScript always attaches the selected file and never treats empty as script.txt", () => {
    assert.equal(withScript("/api/projects/p/script", "script_full_test.txt"), "/api/projects/p/script?script=script_full_test.txt");
    assert.equal(withScript("/api/projects/p/lanes?x=1", "script.txt"), "/api/projects/p/lanes?x=1&script=script.txt");
    assert.equal(withScript("/api/projects/p/script", ""), "/api/projects/p/script");
    assert.equal(withScript("/api/projects/p/script", "   "), "/api/projects/p/script");
    assert.equal(requireScriptName("script_showcase_v2.txt"), "script_showcase_v2.txt");
    assert.throws(() => requireScriptName(""), /No script selected/);
    assert.throws(() => requireScriptName(null), /No script selected/);
  });
});
