import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHEAT_SHEET, scriptSafeName } from "../lib/scriptTags.ts";

const KNOWN_TAGS = new Set([
  "Scene",
  "Location",
  "Cast",
  "Clip",
  "Camera",
  "Audio",
  "Pause",
  "Action",
  "Move",
  "Pose",
  "Swing",
  "Do",
  "View",
  "Layer",
  "Prop",
  "Insert",
]);

describe("script cheat sheet", () => {
  const entries = CHEAT_SHEET.flatMap((group) => group.entries);

  test("every entry has a unique id and a note", () => {
    assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
    for (const entry of entries) assert.ok(entry.note.length > 0, entry.id);
  });

  test("examples are real tags, comments or dialogue lines", () => {
    for (const entry of entries) {
      const text = entry.example("Rodney");
      const tag = text.match(/^\[(\w+):/);
      if (tag) {
        assert.ok(KNOWN_TAGS.has(tag[1]), `${entry.id}: unknown tag ${tag[1]}`);
        assert.ok(text.endsWith("]"), `${entry.id}: tag not closed`);
      } else {
        assert.ok(text.startsWith("#") || text.startsWith("Rodney"), `${entry.id}: ${text}`);
      }
    }
  });

  test("every tag the editor knows has at least one example", () => {
    const seen = new Set(entries.map((e) => e.example("Rodney").match(/^\[(\w+):/)?.[1]).filter(Boolean));
    for (const tag of KNOWN_TAGS) assert.ok(seen.has(tag), `no example for [${tag}:]`);
  });

  test("cameras always give over=, which the parser requires", () => {
    for (const entry of entries.filter((e) => e.id.startsWith("cam-"))) {
      assert.match(entry.example("x"), /\bover=\d/, entry.id);
    }
  });

  test("names with a space are written as their id", () => {
    assert.equal(scriptSafeName("Colnel Klink"), "colnel_klink");
    assert.equal(scriptSafeName("Rodney_hawaii"), "Rodney_hawaii");
    assert.equal(scriptSafeName(""), "Name");
    const clip = entries.find((e) => e.id === "clip");
    assert.ok(clip);
    assert.match(clip.example(scriptSafeName("Colnel Klink")), /^\[Clip: colnel_klink /);
  });
});
