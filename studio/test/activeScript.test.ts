import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isRememberableScript,
  parseActiveScriptMap,
  rememberScript,
  rememberedScript,
} from "../lib/activeScript.ts";

describe("remembered script per project", () => {
  test("keeps the last selected file and ignores junk", () => {
    assert.equal(isRememberableScript("script_full_test.txt"), true);
    assert.equal(isRememberableScript("script.txt"), true);
    assert.equal(isRememberableScript("../secret.txt"), false);
    const map = parseActiveScriptMap(
      JSON.stringify({ rodney_test: "script_showcase_v2.txt", other: "../nope.txt" })
    );
    assert.equal(rememberedScript(map, "rodney_test"), "script_showcase_v2.txt");
    assert.equal(rememberedScript(map, "other"), "");
    const next = rememberScript(map, "rodney_test", "script.txt");
    assert.equal(rememberedScript(next, "rodney_test"), "script.txt");
    assert.equal(rememberedScript(parseActiveScriptMap("not-json"), "rodney_test"), "");
  });
});
