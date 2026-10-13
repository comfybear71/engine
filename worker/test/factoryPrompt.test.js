"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  assembleHiddenPrompt,
  assembleWalkPhasePrompt,
  clampFactoryFrames,
  factoryGrid,
  inferFactoryIntent,
  slugActionId,
  walkPhases,
  buildFactoryPack,
} = require("../src/factoryPrompt");

describe("factory hidden prompt pack", () => {
  test("clamps frames and names a long-stride side walk", () => {
    assert.equal(clampFactoryFrames(7), 8);
    assert.equal(clampFactoryFrames(13), 16);
    assert.deepEqual(factoryGrid(12), { cols: 4, rows: 3 });
    const intent = inferFactoryIntent("Rodney walking long stride");
    assert.equal(intent.kind, "walk");
    assert.equal(slugActionId("Rodney walking long stride", intent), "walk_side_long_stride");
  });

  test("silently adds locked style, green screen, and rig rules", () => {
    const pack = buildFactoryPack({
      character: { id: "rodney", display_name: "Rodney", style: "painted caricature" },
      userPrompt: "Rodney walking long stride",
      frames: 8,
      references: [{ kind: "reference", rel: "characters/rodney/_reference/full.png" }],
    });
    assert.match(pack.hiddenPrompt, /fedora|painted caricature/);
    assert.match(pack.hiddenPrompt, /#00FF00/);
    assert.match(pack.hiddenPrompt, /Only one head/);
    assert.match(pack.hiddenPrompt, /Never zoom into legs/);
    assert.match(pack.hiddenPrompt, /never a close-up of legs/);
    assert.match(pack.hiddenPrompt, /WALK CYCLE/);
    assert.match(pack.hiddenPrompt, /8 DISTINCT phases/);
    const phases = walkPhases(8);
    assert.equal(phases.length, 8);
    const contact = assembleWalkPhasePrompt({
      character: { id: "rodney", display_name: "Rodney" },
      userPrompt: "long strides",
      frames: 8,
      phase: phases[0],
      index: 0,
    });
    const opposite = assembleWalkPhasePrompt({
      character: { id: "rodney", display_name: "Rodney" },
      userPrompt: "long strides",
      frames: 8,
      phase: phases[4],
      index: 4,
    });
    assert.match(contact, /gait phase 1 of 8/);
    assert.match(contact, /right heel striking/);
    assert.match(opposite, /gait phase 5 of 8/);
    assert.match(opposite, /left heel striking/);
    assert.notEqual(contact, opposite);
    assert.match(pack.hiddenPrompt, /right heel striking/);
    assert.match(pack.hiddenPrompt, /left leg swinging past/);
    assert.equal(pack.greenScreen, "#00FF00");
    assert.equal(pack.references[0].rel, "characters/rodney/_reference/full.png");
    assert.equal(assembleHiddenPrompt({
      character: { id: "rodney", display_name: "Rodney" },
      userPrompt: "hi",
      frames: 8,
      advancedPrompt: "custom pack",
    }), "custom pack");
  });

  test("prop, background, new-character, and slot packs stay project-local", () => {
    const prop = buildFactoryPack({
      mode: "prop",
      character: { id: "rodney", display_name: "Rodney", style: "painted caricature" },
      userPrompt: "guitar",
      references: [{ kind: "reference", rel: "characters/rodney/_reference/full.png" }],
    });
    assert.equal(prop.skipReferences, true);
    assert.match(prop.hiddenPrompt, /single isolated object/i);
    assert.match(prop.hiddenPrompt, /#00FF00/);
    assert.doesNotMatch(prop.hiddenPrompt, /characters\/rodney/);
    assert.equal(prop.references.length, 1);

    const bg = buildFactoryPack({
      mode: "background",
      character: { id: "rodney", display_name: "Rodney" },
      userPrompt: "smoky bar",
    });
    assert.equal(bg.aspectRatio, "16:9");
    assert.equal(bg.greenScreen, null);
    assert.match(bg.hiddenPrompt, /16:9/);
    assert.match(bg.hiddenPrompt, /No green screen/i);
    assert.doesNotMatch(bg.hiddenPrompt, /#00FF00/);

    const newbie = buildFactoryPack({
      mode: "new-character",
      name: "Grumpy old barman",
      userPrompt: "grumpy old barman",
      character: { id: "rodney", display_name: "Rodney" },
    });
    assert.equal(newbie.skipReferences, true);
    assert.match(newbie.hiddenPrompt, /full-body standing reference/i);
    assert.match(newbie.hiddenPrompt, /Do not copy any existing character/);

    const eyes = buildFactoryPack({
      mode: "slot",
      slot: "eyes",
      view: "front",
      character: { id: "rodney", display_name: "Rodney" },
      userPrompt: "angry",
    });
    assert.equal(eyes.attachHeadBase, true);
    assert.match(eyes.hiddenPrompt, /ONLY the eyes/i);
    assert.match(eyes.hiddenPrompt, /Never draw a full head/i);
    assert.match(eyes.hiddenPrompt, /1024/);

    const arms = buildFactoryPack({
      mode: "slot",
      slot: "arm",
      view: "front",
      label: "Arms",
      character: { id: "rodney", display_name: "Rodney" },
      userPrompt: "grip mic",
    });
    assert.match(arms.hiddenPrompt, /whole arm/i);
    assert.match(arms.hiddenPrompt, /knuckles face OUT/i);
  });
});
