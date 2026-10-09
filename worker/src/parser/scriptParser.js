"use strict";

/**
 * Turns a script.txt into a validated timeline.json object plus a
 * lines.json manifest, resolving every character/slot/drawing/location/mark
 * reference against the shared asset library (see assetLibrary.js).
 *
 * Timing model: each scene has a single running "cursor" (in frames,
 * starting at 0). Dialogue lines run strictly in sequence against that one
 * cursor (no overlapping dialogue) -- each line's start_frame is the
 * cursor's current value, then the cursor advances by that line's duration
 * (real, via ffprobe, if its audio file already exists; otherwise estimated
 * from word count). [Pause: ...] advances the cursor without emitting a
 * dialogue clip. [Action: ...] takes effect *at* the current cursor
 * position (it doesn't advance it).
 *
 * A character gets exactly one Layer per *position* they hold in a scene:
 * repositioning (a later [Action: ... at=...]/scale=/flip=/z= that actually
 * changes their resolved transform) closes the current layer "segment" and
 * opens a new one with the same character_id, back-to-back in time -- never
 * a duplicate layer for a dialogue line, per the brief.
 */

const fs = require("fs");
const path = require("path");

const { tokenize } = require("./tokenizer");
const { parseActionTag, parseCastList, parsePauseValue } = require("./actionTag");
const { ScriptError } = require("./errors");
const assetLibrary = require("./assetLibrary");
const { probeDurationSeconds } = require("./ffprobeDuration");
const { findOverlapWarnings, findMouthSheetErrors } = require("./lint");

const WORDS_PER_SECOND = 2.5;
const ESTIMATE_PAD_SECONDS = 0.3;
const DEFAULT_SCENE_PADDING_FRAMES = 12;
const RESERVED_SLOT_NAMES = new Set(["mouth"]); // dialogue-driven only, never settable via [Action: ...]

function slugify(text) {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "scene"
  );
}

function estimateDurationSeconds(text) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length || 1;
  return wordCount / WORDS_PER_SECOND + ESTIMATE_PAD_SECONDS;
}

function framesFromSeconds(seconds, fps) {
  return Math.max(0, Math.round(seconds * fps));
}

/** Loads + caches character.json by id, building an alias -> id index as it goes. */
class CharacterLibrary {
  constructor(projectDir, globalAssetsDir) {
    this.projectDir = projectDir;
    this.globalAssetsDir = globalAssetsDir;
    this._byId = new Map();
    this._aliasToId = new Map();
    for (const id of assetLibrary.listKnownCharacterIds(projectDir, globalAssetsDir)) {
      const config = assetLibrary.loadCharacter(projectDir, globalAssetsDir, id);
      if (!config) continue;
      this._byId.set(id, config);
      const names = [config.id, config.display_name, ...(config.aliases || [])].filter(Boolean);
      for (const name of names) this._aliasToId.set(name.toLowerCase(), config.id);
    }
  }

  get(characterId) {
    return this._byId.get(characterId) || null;
  }

  resolveIdByScriptName(scriptName) {
    return this._aliasToId.get(scriptName.toLowerCase()) || null;
  }

  knownNamesSummary() {
    return [...this._byId.values()].map((c) => c.display_name || c.id).join(", ") || "(none)";
  }
}

/** All per-scene mutable parsing state lives here. */
class SceneContext {
  constructor(sceneId, fps) {
    this.sceneId = sceneId;
    this.fps = fps;
    this.location = null;
    this.staging = null;
    this.background = null;
    this.castOrder = []; // character ids, in [Cast: ...]/first-appearance order
    this.characters = new Map(); // character_id -> CharacterSceneState
    this.cursorFrames = 0;
    this.lineCounter = 0; // for audio/<scene>/<nnn>_<char>.wav naming
  }
}

class CharacterSceneState {
  constructor(characterId, config) {
    this.characterId = characterId;
    this.config = config;
    this.segments = []; // finished segments (plain JSON layer objects)
    this.current = null; // the open segment draft, or null
  }
}

function newSegmentDraft(layerId, startFrame, transform, z, markName) {
  return {
    layerId,
    startFrame,
    transform,
    z,
    markName,
    dialogue: [],
    slotKeyframes: new Map(), // slotName -> [{frame, drawing}]
    childSlotKeyframes: new Map(), // childId -> Map(slotName -> [{frame, drawing}])
  };
}

function transformsDiffer(a, b) {
  if (!a || !b) return true;
  return a.x !== b.x || a.y !== b.y || a.scale !== b.scale || !!a.flip_x !== !!b.flip_x;
}

class ScriptParser {
  constructor(projectDir, globalAssetsDir, options = {}) {
    this.projectDir = projectDir;
    this.globalAssetsDir = globalAssetsDir;
    this.series = options.series || "Untitled Series";
    this.episode = options.episode != null ? options.episode : "pilot";
    this.fps = options.fps || 24;
    this.characterLibrary = new CharacterLibrary(projectDir, globalAssetsDir);
    this.scenes = [];
    this.lines = [];
    this.warnings = [];
    this.errors = [];
    this._usedSceneIds = new Set();
    this.usedCharacters = new Map(); // characterId -> character.json (used in this script)
    this.occupancy = []; // per-segment mark/z intervals, for the overlap lint
    this.scene = null; // current SceneContext
  }

  // ---- top-level driver -------------------------------------------------

  async parse(scriptText) {
    const tokens = tokenize(scriptText);
    for (const token of tokens) {
      await this._handleToken(token);
    }
    this._closeScene(); // flush the last scene, if any
    this._runLintChecks();

    const timeline = {
      series: this.series,
      episode: this.episode,
      fps: this.fps,
      scenes: this.scenes,
    };
    return { timeline, lines: this.lines, warnings: this.warnings, errors: this.errors };
  }

  async _handleToken(token) {
    switch (token.kind) {
      case "decorative":
        return;
      case "scene":
        this._closeScene();
        this._openScene(token);
        return;
      case "location":
        this._handleLocation(token);
        return;
      case "cast":
        this._handleCast(token);
        return;
      case "action":
        this._handleAction(token);
        return;
      case "pause":
        this._handlePause(token);
        return;
      case "dialogue":
        await this._handleDialogue(token);
        return;
      default:
        throw new ScriptError(token.lineNumber, `Internal error: unhandled token kind "${token.kind}"`);
    }
  }

  // ---- scene / location / cast ------------------------------------------

  _openScene(token) {
    const name = token.body.trim();
    if (!name) throw new ScriptError(token.lineNumber, "[Scene: ...] needs a name, e.g. [Scene: Kitchen Argument].");
    let id = slugify(name);
    let suffix = 2;
    while (this._usedSceneIds.has(id)) {
      id = `${slugify(name)}_${suffix++}`;
    }
    this._usedSceneIds.add(id);
    this.scene = new SceneContext(id, this.fps);
    this.scene.displayName = name;
  }

  _requireScene(lineNumber, tagName) {
    if (!this.scene) {
      throw new ScriptError(lineNumber, `[${tagName}: ...] appeared before any [Scene: ...].`);
    }
    return this.scene;
  }

  _handleLocation(token) {
    const scene = this._requireScene(token.lineNumber, "Location");
    const locationId = slugify(token.body.trim());
    const bg = assetLibrary.resolveAsset(this.projectDir, this.globalAssetsDir, `backgrounds/${locationId}/bg.png`);
    if (!bg) {
      const known = assetLibrary.listKnownLocations(this.projectDir, this.globalAssetsDir);
      throw new ScriptError(
        token.lineNumber,
        `Unknown location "${token.body.trim()}" (no backgrounds/${locationId}/bg.png). Available: ${known.join(", ") || "(none)"}`
      );
    }
    scene.location = locationId;
    scene.background = bg.timelinePath;
    scene.staging = assetLibrary.loadStaging(this.projectDir, this.globalAssetsDir, locationId);
  }

  _handleCast(token) {
    const scene = this._requireScene(token.lineNumber, "Cast");
    const names = parseCastList(token.body);
    for (const name of names) {
      const characterId = this._resolveCharacterIdOrThrow(name, token.lineNumber);
      if (!scene.castOrder.includes(characterId)) {
        scene.castOrder.push(characterId);
      }
      this._ensureCharacterPositioned(scene, characterId, token.lineNumber);
    }
  }

  // ---- character resolution + staging/marks ------------------------------

  _resolveCharacterIdOrThrow(scriptName, lineNumber) {
    const id = this.characterLibrary.resolveIdByScriptName(scriptName);
    if (!id) {
      throw new ScriptError(
        lineNumber,
        `Unknown character "${scriptName}". Known characters: ${this.characterLibrary.knownNamesSummary()}`
      );
    }
    return id;
  }

  _getOrCreateCharacterState(scene, characterId) {
    let state = scene.characters.get(characterId);
    if (!state) {
      const config = this.characterLibrary.get(characterId);
      state = new CharacterSceneState(characterId, config);
      scene.characters.set(characterId, state);
    }
    if (state.config && !this.usedCharacters.has(characterId)) {
      this.usedCharacters.set(characterId, state.config);
    }
    return state;
  }

  /** Resolves a mark name (explicit or auto-assigned) to {x,y,scale,flip_x}. */
  _resolveMark(scene, markName, lineNumber) {
    if (!scene.staging) {
      throw new ScriptError(lineNumber, `No [Location: ...] set yet for scene "${scene.displayName}" -- can't resolve marks.`);
    }
    const mark = scene.staging.marks[markName];
    if (!mark) {
      throw new ScriptError(
        lineNumber,
        `Unknown mark "${markName}" for location "${scene.location}". Available: ${Object.keys(scene.staging.marks).join(", ") || "(none)"}`
      );
    }
    return mark;
  }

  _autoAssignMark(scene, characterId) {
    const order = scene.staging ? scene.staging.autoOrder : assetLibrary.DEFAULT_AUTO_ORDER;
    const index = scene.castOrder.indexOf(characterId);
    const markName = order[((index % order.length) + order.length) % order.length];
    return markName;
  }

  /**
   * Ensures `characterId` has an open layer segment in this scene, placing
   * them on an auto-assigned mark (by Cast order) if they don't have one
   * yet and no explicit position has been given. No-op if already placed.
   */
  _ensureCharacterPositioned(scene, characterId, lineNumber) {
    const state = this._getOrCreateCharacterState(scene, characterId);
    if (state.current) return state;

    const markName = this._autoAssignMark(scene, characterId);
    const mark = this._resolveMark(scene, markName, lineNumber);
    this._openSegment(scene, state, { markSource: "auto", mark, markName, actionKv: {} }, lineNumber);
    return state;
  }

  /** Builds the resolved {x,y,scale,flip_x,z} for a character given a mark + Action overrides. */
  _resolveTransformAndZ(state, mark, actionKv) {
    const config = state.config || {};
    const x = mark.x;
    const y = mark.y;

    const scale = actionKv.scale !== undefined ? parseFloat(actionKv.scale) : mark.scale !== undefined ? mark.scale : config.default_scale !== undefined ? config.default_scale : 1.0;

    let flipX;
    if (actionKv.flip !== undefined) flipX = actionKv.flip === "true" || actionKv.flip === "1";
    else if (mark.flip_x !== undefined) flipX = !!mark.flip_x;
    else if (config.default_flip_x !== undefined) flipX = !!config.default_flip_x;
    else flipX = false;

    const z = actionKv.z !== undefined ? parseInt(actionKv.z, 10) : config.z !== undefined ? config.z : 0;

    return { transform: { x, y, scale, flip_x: flipX, anchor: "bottom-center" }, z };
  }

  _openSegment(scene, state, { mark, markName, actionKv }, lineNumber) {
    const { transform, z } = this._resolveTransformAndZ(state, mark, actionKv || {});
    const segmentIndex = state.segments.length + 1;
    const layerId = segmentIndex === 1 ? state.characterId : `${state.characterId}_${segmentIndex}`;
    state.current = newSegmentDraft(layerId, scene.cursorFrames, transform, z, markName);
    state.current._lineNumber = lineNumber;
  }

  _closeCurrentSegment(state, endFrame) {
    if (!state.current) return;
    state.current.endFrame = endFrame;
    state.segments.push(state.current);
    state.current = null;
  }

  // ---- [Action: ...] -------------------------------------------------------

  _handleAction(token) {
    const scene = this._requireScene(token.lineNumber, "Action");
    const { character: scriptName, kv, note } = parseActionTag(token.body);
    if (!scriptName) throw new ScriptError(token.lineNumber, "[Action: ...] needs a character name.");
    const characterId = this._resolveCharacterIdOrThrow(scriptName, token.lineNumber);

    if (!scene.castOrder.includes(characterId)) {
      scene.castOrder.push(characterId);
    }
    const state = this._ensureCharacterPositioned(scene, characterId, token.lineNumber);
    void note; // free-text note: intentionally not an error, not otherwise used yet

    const positionKeys = ["at", "scale", "flip", "z"];
    const hasPositionChange = positionKeys.some((k) => kv[k] !== undefined);

    if (hasPositionChange) {
      const markName = kv.at !== undefined ? kv.at : this._autoAssignMark(scene, characterId);
      const mark = this._resolveMark(scene, markName, token.lineNumber);
      const { transform: newTransform, z: newZ } = this._resolveTransformAndZ(state, mark, kv);
      const current = state.current;
      const noTimeHasPassedSinceSegmentOpened = current && current.startFrame === scene.cursorFrames;

      if (current && noTimeHasPassedSinceSegmentOpened) {
        // This is still "the same moment" the current segment opened at (e.g.
        // [Cast: ...] auto-assigned a mark and this [Action: ... at=...] is
        // immediately correcting it before any dialogue/pause has happened) --
        // update it in place rather than forking a pointless extra segment.
        current.transform = newTransform;
        current.z = newZ;
        current.markName = markName;
        current._lineNumber = token.lineNumber;
      } else if (!current || transformsDiffer(current.transform, newTransform) || current.z !== newZ) {
        this._closeCurrentSegment(state, scene.cursorFrames);
        this._openSegment(scene, state, { mark, markName, actionKv: kv }, token.lineNumber);
      }
    }

    for (const [key, value] of Object.entries(kv)) {
      if (positionKeys.includes(key)) continue;
      this._applySlotKeyframe(scene, state, characterId, key, value, token.lineNumber);
    }
  }

  _findSlotOwner(config, slotName) {
    if (config.slots && config.slots[slotName]) {
      return { ownerType: "layer", slotConfig: config.slots[slotName] };
    }
    for (const child of config.children || []) {
      if (child.slots && child.slots[slotName]) {
        return { ownerType: "child", childId: child.id, slotConfig: child.slots[slotName] };
      }
    }
    return null;
  }

  _applySlotKeyframe(scene, state, characterId, slotName, drawing, lineNumber) {
    if (RESERVED_SLOT_NAMES.has(slotName)) {
      throw new ScriptError(lineNumber, `"${slotName}" is driven by dialogue automatically and can't be set via [Action: ...].`);
    }
    const config = state.config;
    if (!config) throw new ScriptError(lineNumber, `Character "${characterId}" has no character.json (can't resolve slot "${slotName}").`);

    const owner = this._findSlotOwner(config, slotName);
    if (!owner) {
      const available = [
        ...Object.keys(config.slots || {}),
        ...(config.children || []).flatMap((c) => Object.keys(c.slots || {})),
      ];
      throw new ScriptError(
        lineNumber,
        `${config.display_name || characterId} has no "${slotName}" slot. Available: ${available.join(", ") || "(none)"}`
      );
    }

    const drawingsDir = `characters/${characterId}/${owner.slotConfig.drawings_dir}`;
    const drawings = assetLibrary.scanDrawingsDir(this.projectDir, this.globalAssetsDir, drawingsDir);
    if (!drawings.has(drawing)) {
      throw new ScriptError(
        lineNumber,
        `${config.display_name || characterId} has no ${slotName} drawing "${drawing}". Available: ${[...drawings.keys()].join(", ") || "(none)"}`
      );
    }

    const segment = state.current;
    const relativeFrame = scene.cursorFrames - segment.startFrame;
    const keyframe = { frame: relativeFrame, drawing };

    let bucket;
    if (owner.ownerType === "layer") {
      bucket = segment.slotKeyframes.get(slotName) || [];
      segment.slotKeyframes.set(slotName, bucket);
    } else {
      let childMap = segment.childSlotKeyframes.get(owner.childId);
      if (!childMap) {
        childMap = new Map();
        segment.childSlotKeyframes.set(owner.childId, childMap);
      }
      bucket = childMap.get(slotName) || [];
      childMap.set(slotName, bucket);
    }
    // Replace any keyframe already at this exact frame (re-setting the same slot twice at once) instead of duplicating it.
    const existingIdx = bucket.findIndex((k) => k.frame === relativeFrame);
    if (existingIdx !== -1) bucket[existingIdx] = keyframe;
    else bucket.push(keyframe);
  }

  // ---- [Pause: ...] ----------------------------------------------------

  _handlePause(token) {
    const scene = this._requireScene(token.lineNumber, "Pause");
    const { frames, seconds } = parsePauseValue(token.body, token.lineNumber);
    const advance = frames !== undefined ? frames : framesFromSeconds(seconds, this.fps);
    scene.cursorFrames += advance;
  }

  // ---- dialogue lines ----------------------------------------------------

  async _handleDialogue(token) {
    const scene = this._requireScene(token.lineNumber, "dialogue");
    let characterId = this.characterLibrary.resolveIdByScriptName(token.character);
    if (!characterId) {
      throw new ScriptError(
        token.lineNumber,
        `Unknown character "${token.character}". Known characters: ${this.characterLibrary.knownNamesSummary()}`
      );
    }

    if (!scene.castOrder.includes(characterId)) {
      this.warnings.push(
        `Line ${token.lineNumber}: "${token.character}" speaks but was not in [Cast: ...] for scene "${scene.displayName}"; added automatically.`
      );
      scene.castOrder.push(characterId);
    }
    const state = this._ensureCharacterPositioned(scene, characterId, token.lineNumber);

    scene.lineCounter += 1;
    const lineNo = String(scene.lineCounter).padStart(3, "0");
    const audioRelPath = `audio/${scene.sceneId}/${lineNo}_${characterId}.wav`;
    const absAudioPath = path.join(this.projectDir, audioRelPath);

    let durationSeconds;
    let status;
    if (fs.existsSync(absAudioPath)) {
      durationSeconds = await probeDurationSeconds(absAudioPath);
      status = "ok";
    } else {
      durationSeconds = estimateDurationSeconds(token.text);
      status = "missing";
    }
    const durationFrames = framesFromSeconds(durationSeconds, this.fps);
    const startFrame = scene.cursorFrames;

    const clip = {
      audio: audioRelPath,
      start_frame: startFrame - state.current.startFrame,
      text: token.text,
    };
    if (status === "missing") {
      // Marked on the clip itself (not only in lines.json) so a silent
      // preview render can use the estimate without re-reading the manifest.
      clip.estimated = true;
      clip.estimated_duration_seconds = Math.round(durationSeconds * 100) / 100;
    }
    state.current.dialogue.push(clip);

    this.lines.push({
      scene_id: scene.sceneId,
      line_number: scene.lineCounter,
      character: characterId,
      text: token.text,
      audio_path: audioRelPath,
      cues_path: `${audioRelPath}.rhubarb.json`,
      voice_id: (state.config && state.config.voice_id) || null,
      status,
      ...(status === "missing" ? { estimated_duration_seconds: Math.round(durationSeconds * 100) / 100 } : {}),
    });

    scene.cursorFrames += durationFrames;
  }

  // ---- lint (overlap warnings + mouth-sheet errors) ----------------------

  _recordOccupancy(scene) {
    for (const state of scene.characters.values()) {
      const displayName = (state.config && (state.config.display_name || state.config.id)) || state.characterId;
      for (const segment of state.segments) {
        if (!segment.markName) continue;
        this.occupancy.push({
          sceneId: scene.sceneId,
          characterId: state.characterId,
          displayName,
          markName: segment.markName,
          z: segment.z,
          startFrame: segment.startFrame,
          endFrame: segment.endFrame === undefined ? Number.POSITIVE_INFINITY : segment.endFrame,
          lineNumber: segment._lineNumber,
        });
      }
    }
  }

  _runLintChecks() {
    this.warnings.push(...findOverlapWarnings(this.occupancy));
    this.errors.push(...findMouthSheetErrors(this.usedCharacters, this.projectDir, this.globalAssetsDir));
  }

  // ---- scene finalization -------------------------------------------------

  _closeScene() {
    const scene = this.scene;
    if (!scene) return;

    for (const state of scene.characters.values()) {
      this._closeCurrentSegment(state, undefined); // undefined end_frame -> "through end of scene"
    }

    this._recordOccupancy(scene);

    const layers = [];
    let anyDialogue = false;
    for (const state of scene.characters.values()) {
      for (const segment of state.segments) {
        anyDialogue = anyDialogue || segment.dialogue.length > 0;
        layers.push(this._buildLayerJson(state, segment));
      }
    }

    const duration =
      anyDialogue
        ? { from_dialogue: true, padding_frames: DEFAULT_SCENE_PADDING_FRAMES }
        : { frames: Math.max(scene.cursorFrames, this.fps) }; // at least 1s for a silent/establishing scene

    this.scenes.push({
      id: scene.sceneId,
      duration,
      background: { asset: scene.background },
      layers,
    });

    this.scene = null;
  }

  _buildLayerJson(state, segment) {
    const config = state.config || {};
    const bodyAsset = assetLibrary.resolveAsset(this.projectDir, this.globalAssetsDir, `characters/${state.characterId}/${config.asset || "body.png"}`);

    const layer = {
      id: segment.layerId,
      character_id: state.characterId,
      asset: bodyAsset.timelinePath,
      z: segment.z,
      transform: segment.transform,
    };
    if (segment.startFrame !== 0 || segment.endFrame !== undefined) {
      layer.timing = { start_frame: segment.startFrame };
      if (segment.endFrame !== undefined) layer.timing.end_frame = segment.endFrame;
    }
    if (segment.dialogue.length > 0) layer.dialogue = segment.dialogue;

    const slots = {};
    if (segment.dialogue.length > 0 && config.slots && config.slots.mouth) {
      slots.mouth = this._buildSlotJson(state.characterId, "mouth", config.slots.mouth, []);
    }
    for (const [slotName, slotConfig] of Object.entries(config.slots || {})) {
      if (slotName === "mouth") continue;
      slots[slotName] = this._buildSlotJson(state.characterId, slotName, slotConfig, segment.slotKeyframes.get(slotName) || []);
    }
    if (Object.keys(slots).length > 0) layer.slots = slots;

    if ((config.children || []).length > 0) {
      layer.children = config.children.map((child) => this._buildChildJson(state.characterId, child, segment.childSlotKeyframes.get(child.id)));
    }

    return layer;
  }

  _buildSlotJson(characterId, slotName, slotConfig, keyframes) {
    if (slotName === "mouth") {
      const images = this._scanSlotImages(characterId, slotConfig);
      return { offset: slotConfig.offset || { x: 0, y: 0 }, images, lipsync: { source: "dialogue" } };
    }
    const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
    if (sorted.length === 0 || sorted[0].frame !== 0) {
      sorted.unshift({ frame: 0, drawing: slotConfig.default_drawing });
    }
    const images = this._scanSlotImages(characterId, slotConfig);
    return { offset: slotConfig.offset || { x: 0, y: 0 }, images, keyframes: sorted };
  }

  _scanSlotImages(characterId, slotConfig) {
    const drawingsDir = `characters/${characterId}/${slotConfig.drawings_dir}`;
    const drawings = assetLibrary.scanDrawingsDir(this.projectDir, this.globalAssetsDir, drawingsDir);
    const images = {};
    for (const [name, file] of drawings.entries()) images[name] = file.timelinePath;
    return images;
  }

  _buildChildJson(characterId, childConfig, slotKeyframesMap) {
    const asset = assetLibrary.resolveAsset(this.projectDir, this.globalAssetsDir, `characters/${characterId}/${childConfig.asset}`);
    const child = {
      id: childConfig.id,
      asset: asset.timelinePath,
      z: childConfig.z,
      offset: childConfig.offset || { x: 0, y: 0 },
    };
    if (childConfig.pivot) child.pivot = childConfig.pivot;
    if (childConfig.scale !== undefined) child.scale = childConfig.scale;
    if (childConfig.flip_x !== undefined) child.flip_x = childConfig.flip_x;
    if (childConfig.rotation !== undefined) child.rotation = childConfig.rotation;

    if (childConfig.slots) {
      const slots = {};
      for (const [slotName, slotConfig] of Object.entries(childConfig.slots)) {
        const keyframes = (slotKeyframesMap && slotKeyframesMap.get(slotName)) || [];
        slots[slotName] = this._buildSlotJson(characterId, slotName, slotConfig, keyframes);
      }
      child.slots = slots;
    }
    return child;
  }
}

async function parseScript(projectDir, globalAssetsDir, scriptText, options = {}) {
  const parser = new ScriptParser(projectDir, globalAssetsDir, options);
  return parser.parse(scriptText);
}

module.exports = { parseScript, ScriptParser, slugify, estimateDurationSeconds, framesFromSeconds };
