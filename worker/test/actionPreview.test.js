"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { actionPreviewSeconds, buildActionPreviewScript } = require("../src/actionPreview");

describe("action preview helpers", () => {
  test("loops 1-3 seconds and writes a Do: script", () => {
    assert.equal(actionPreviewSeconds(8, 12), 2);
    assert.equal(actionPreviewSeconds(24, 12), 2);
    const script = buildActionPreviewScript("Rodney", "curtain", "walk_side", 2);
    assert.match(script, /\[Location: curtain\]/);
    assert.match(script, /\[Do: Rodney walk_side for=2s wait=false\]/);
  });
});
