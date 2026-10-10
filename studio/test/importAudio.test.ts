import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  acceptAudioFile,
  buildAudioTag,
  explainImportAudioError,
  suggestedLabelFromFilename,
  summarizeDryRun,
} from "../lib/importAudio.ts";
import { insertSnippetAtCursor } from "../lib/scriptTags.ts";

describe("import audio helpers", () => {
  test("accepts mp3/wav and builds the script tag", () => {
    assert.equal(acceptAudioFile({ name: "take.MP3", type: "" }).ok, true);
    assert.equal(acceptAudioFile({ name: "line.wav", type: "audio/wav" }).ok, true);
    const bad = acceptAudioFile({ name: "notes.txt", type: "text/plain" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.error, /mp3 or wav/);
    assert.equal(suggestedLabelFromFilename("My Take 01.mp3"), "my_take_01");
    assert.equal(buildAudioTag("Hicks", "My Take 01"), "[Audio: Hicks file=my_take_01]");
  });

  test("Insert Action cursor insert puts the audio tag on its own line", () => {
    const mid = insertSnippetAtCursor("Hicks: Hello.", "[Audio: Hicks file=take]", 13, 13);
    assert.equal(mid.next, "Hicks: Hello.\n[Audio: Hicks file=take]\n");
    const empty = insertSnippetAtCursor("", "[Audio: Dana file=take]", 0, 0);
    assert.equal(empty.next, "[Audio: Dana file=take]\n");
  });

  test("dry-run summary and errors are in plain words", () => {
    const credits = summarizeDryRun({
      durationSeconds: 3.25,
      creditNote: "Audio length: 3.3s. Transcription uses ElevenLabs Speech-to-Text credits. Use --no-transcribe to skip STT.",
      noTranscribe: false,
      estimatedCost: 0.04,
    });
    assert.equal(credits.durationLabel, "3.3s");
    assert.equal(credits.usesCredits, true);
    assert.match(credits.creditNote, /ElevenLabs/);
    assert.doesNotMatch(credits.creditNote, /--no-transcribe/);
    assert.equal(credits.estimatedCost, "about $0.040");

    const skipped = summarizeDryRun(
      { durationSeconds: 90, creditNote: "unused", noTranscribe: false },
      { noTranscribe: true }
    );
    assert.equal(skipped.durationLabel, "1m 30s");
    assert.equal(skipped.usesCredits, false);
    assert.match(skipped.creditNote, /skipped/i);

    assert.match(explainImportAudioError("ELEVENLABS_API_KEY is not set. Copy .env.example to .env and add your key."), /API key/);
    assert.match(explainImportAudioError("warning: Rhubarb not found on PATH (or RHUBARB_PATH)."), /mouth-shape tool/i);
    assert.doesNotMatch(explainImportAudioError("Unknown character \"x\". Known characters: Hicks"), /--character/);
  });
});
