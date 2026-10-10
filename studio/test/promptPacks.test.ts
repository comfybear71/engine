import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explainGenerateError, summarizeGenerateCost } from "../lib/generateImage.ts";
import { fillPackPrompt, ingestNeedId, packForCharacter, PROMPT_PACKS } from "../lib/promptPacks.ts";

describe("prompt packs", () => {
  test("Rodney pack fills a complete style-block prompt and maps ingest ids", () => {
    const pack = packForCharacter({ id: "rodney", display_name: "Rodney" });
    assert.ok(pack);
    assert.equal(PROMPT_PACKS.length >= 1, true);
    const mouths = pack.sets.find((set) => set.id === "mouth_sheet");
    assert.ok(mouths);
    assert.equal(ingestNeedId(mouths), "mouth_sheet");
    const prompt = fillPackPrompt(mouths, { name: "Rodney", styleBlock: pack.styleBlock });
    assert.match(prompt, /battered crimson felt fedora/);
    assert.match(prompt, /never slanted eyes/i);
    const thirteen = pack.sets.find((set) => set.id === "mouth_13_left_side");
    assert.ok(thirteen);
    assert.match(fillPackPrompt(thirteen, { name: "Rodney", styleBlock: pack.styleBlock }), /B_loud/);
    assert.equal(packForCharacter({ id: "hicks", display_name: "Hicks" }), null);
  });

  test("generate errors and cost notes stay in plain words", () => {
    assert.match(explainGenerateError("The xAI API key is missing. Open Settings and paste your key."), /Settings/);
    assert.match(explainGenerateError("xAI rate limit — wait a minute and try again."), /rate limit/);
    const summary = summarizeGenerateCost({
      creditNote: "This uses xAI credits. About $0.080 for 2 variants.",
      estimatedCost: 0.08,
    });
    assert.match(summary.creditNote, /uses xAI credits/);
    assert.equal(summary.estimatedCost, "about $0.080");
  });
});
