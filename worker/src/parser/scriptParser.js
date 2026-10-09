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
 * position (it doesn't advance it). [Move:]/[Pose:]/[Swing:] write
 * keyframes on the current layer; wait=true (default) advances the cursor
 * like [Pause], wait=false leaves it so following lines run during the motion.
 *
 * A character gets exactly one Layer per *cut* they hold in a scene:
 * an [Action: ... at=/flip=/scale=/z=] that actually changes their resolved
 * transform closes the current layer "segment" and opens a new one with the
 * same character_id, back-to-back in time. [Move:] does *not* fork a layer --
 * it adds transform_keyframes on the current one. Flip still forks (flip_x
 * is not keyframed); the new layer starts at the post-Move position.
 */

const fs = require("fs");
const path = require("path");

const { tokenize } = require("./tokenizer");
const {
  parseActionTag,
  noteHasKeyValue,
  parseCastList,
  parsePauseValue,
  parseSecondsSpec,
  parseEaseValue,
  parseWaitValue,
  parseNumberValue,
  parseXyPair,
  KEY_VALUE_RE,
} = require("./actionTag");
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

function slotStateKey(owner, slotName) {
  return owner.ownerType === "child" ? `${owner.childId}:${slotName}` : slotName;
}

/** Timeline keyframe at local frame 0 that continues `active` at `scene`'s cursor. */
function keyframeFromActive(active, scene) {
  if (active.cycle && active.cycle.length > 0) {
    const elapsed = Math.max(0, scene.cursorFrames - (active.startedAtSceneFrame || 0));
    const index = Math.floor((elapsed / scene.fps) * active.fps) % active.cycle.length;
    const rotated = active.cycle.slice(index).concat(active.cycle.slice(0, index));
    return { frame: 0, cycle: rotated, fps: active.fps };
  }
  return { frame: 0, drawing: active.drawing };
}

/**
 * Back-and-forth rotation samples around `center`, amplitude `amplitude`
 * (sign = first-swing direction). Quarter-period keys: center, +amp,
 * center, -amp, ... and a final key at `durationFrames` back at center.
 * Frames are offset by `startRel`. Ease is inout on every departing key.
 */
function swingRotationKeyframes(center, amplitude, periodFrames, durationFrames, startRel) {
  const quarter = periodFrames / 4;
  const sequence = [center, center + amplitude, center, center - amplitude];
  const keys = [];
  let step = 0;
  while (true) {
    const frame = Math.round(step * quarter);
    if (frame > durationFrames) break;
    if (frame === durationFrames) {
      keys.push({ frame: startRel + frame, rotation: center });
      break;
    }
    keys.push({ frame: startRel + frame, rotation: sequence[step % 4], ease: "inout" });
    step += 1;
  }
  const lastFrame = startRel + durationFrames;
  if (keys.length === 0 || keys[keys.length - 1].frame !== lastFrame) {
    keys.push({ frame: lastFrame, rotation: center });
  } else {
    keys[keys.length - 1].rotation = center;
    delete keys[keys.length - 1].ease;
  }
  return keys;
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
    this.horizonFrames = 0; // latest animation end, including wait=false motions
    this.lineCounter = 0; // for audio/<scene>/<nnn>_<char>.wav naming
  }
}

class CharacterSceneState {
  constructor(characterId, config) {
    this.characterId = characterId;
    this.config = config;
    this.segments = []; // finished segments (plain JSON layer objects)
    this.current = null; // the open segment draft, or null
    this.childRotations = new Map(); // childId -> current degrees (survives layer forks)
    // Last Action-set drawing/cycle per slot, so a forked layer can continue
    // it instead of snapping back to default_drawing.
    this.activeSlots = new Map(); // slotStateKey -> { ownerType, childId?, slotName, drawing?, cycle?, fps?, startedAtSceneFrame? }
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
    slotKeyframes: new Map(), // slotName -> [{frame, drawing|cycle}]
    childSlotKeyframes: new Map(), // childId -> Map(slotName -> [{frame, drawing|cycle}])
    transformKeyframes: [], // [{frame, x?, y?, scale?, rotation?, ease?}]
    childRotationKeyframes: new Map(), // childId -> [{frame, rotation, ease?}]
    openingTransform: { ...transform },
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
      case "move":
        this._handleMove(token);
        return;
      case "pose":
        this._handlePose(token);
        return;
      case "swing":
        this._handleSwing(token);
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

  _openSegment(scene, state, { mark, markName, actionKv, transform, z }, lineNumber) {
    let resolvedTransform = transform;
    let resolvedZ = z;
    if (resolvedTransform === undefined) {
      const resolved = this._resolveTransformAndZ(state, mark, actionKv || {});
      resolvedTransform = resolved.transform;
      resolvedZ = resolved.z;
    }
    const segmentIndex = state.segments.length + 1;
    const layerId = segmentIndex === 1 ? state.characterId : `${state.characterId}_${segmentIndex}`;
    state.current = newSegmentDraft(layerId, scene.cursorFrames, resolvedTransform, resolvedZ, markName);
    state.current._lineNumber = lineNumber;
  }

  _noteHorizon(scene, absFrame) {
    if (absFrame > scene.horizonFrames) scene.horizonFrames = absFrame;
  }

  _applyWait(scene, durationFrames, wait) {
    this._noteHorizon(scene, scene.cursorFrames + durationFrames);
    if (wait) scene.cursorFrames += durationFrames;
  }

  _closeCurrentSegment(state, endFrame) {
    if (!state.current) return;
    state.current.endFrame = endFrame;
    // Snapshot pose at close so a later [Pose] on the next layer cannot
    // rewrite this segment's static child rotations.
    state.current.closingChildRotations = new Map(state.childRotations);
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
    this._warnNoteLooksLikeAssignments(token.lineNumber, "Action", note);

    const positionKeys = ["at", "scale", "flip", "z"];
    const hasPositionChange = positionKeys.some((k) => kv[k] !== undefined);

    if (hasPositionChange) {
      const current = state.current;
      let newTransform;
      let newZ;
      let markName;

      if (kv.at !== undefined) {
        markName = kv.at;
        const mark = this._resolveMark(scene, markName, token.lineNumber);
        ({ transform: newTransform, z: newZ } = this._resolveTransformAndZ(state, mark, kv));
      } else if (current) {
        // flip / scale / z only: stay at the current (possibly moved-to) position
        // rather than re-resolving the original auto-assigned mark.
        markName = current.markName;
        newTransform = { ...current.transform };
        if (kv.scale !== undefined) {
          const scale = parseNumberValue(kv.scale, token.lineNumber, "scale");
          if (scale <= 0) {
            throw new ScriptError(token.lineNumber, `Invalid scale "${kv.scale}" -- must be greater than 0.`);
          }
          newTransform.scale = scale;
        }
        if (kv.flip !== undefined) newTransform.flip_x = kv.flip === "true" || kv.flip === "1";
        if (kv.z !== undefined) {
          const z = parseInt(kv.z, 10);
          if (!Number.isFinite(z)) {
            throw new ScriptError(token.lineNumber, `Invalid z "${kv.z}" -- expected an integer.`);
          }
          newZ = z;
        } else {
          newZ = current.z;
        }
      } else {
        markName = this._autoAssignMark(scene, characterId);
        const mark = this._resolveMark(scene, markName, token.lineNumber);
        ({ transform: newTransform, z: newZ } = this._resolveTransformAndZ(state, mark, kv));
      }

      const sameFrameAsSegmentStart = current && current.startFrame === scene.cursorFrames;
      const hasMotionKeyframes = current && current.transformKeyframes && current.transformKeyframes.length > 0;

      if (current && sameFrameAsSegmentStart) {
        // Same moment the current segment opened (Cast auto-mark then
        // [Action: at=...], or a wait=false [Move] then [Action: flip]).
        // Never fork a zero-length layer. If a Move already wrote keyframes,
        // keep them and only apply flip/scale/z -- an explicit at= still
        // replaces the pose (instant cut).
        if (hasMotionKeyframes && kv.at === undefined) {
          current.transform = { ...current.transform, flip_x: newTransform.flip_x };
          current.openingTransform = { ...current.openingTransform, flip_x: newTransform.flip_x };
          if (kv.scale !== undefined) {
            current.transform.scale = newTransform.scale;
            current.openingTransform.scale = newTransform.scale;
          }
          current.z = newZ;
        } else {
          current.transform = newTransform;
          current.openingTransform = { ...newTransform };
          current.z = newZ;
          current.markName = markName;
          if (kv.at !== undefined) current.transformKeyframes = [];
        }
        current._lineNumber = token.lineNumber;
      } else if (!current || transformsDiffer(current.transform, newTransform) || current.z !== newZ) {
        const hadOpenSegment = !!current;
        this._closeCurrentSegment(state, scene.cursorFrames);
        this._openSegment(
          scene,
          state,
          { markName, actionKv: kv, transform: newTransform, z: newZ },
          token.lineNumber
        );
        if (hadOpenSegment) {
          const skipSlots = new Set(Object.keys(kv).filter((k) => !positionKeys.includes(k)));
          this._carryActiveSlots(state, scene, skipSlots);
        }
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
    const cycles = (owner.slotConfig && owner.slotConfig.cycles) || {};
    const namedCycle = cycles[drawing];
    const displayName = config.display_name || characterId;

    let keyframe;
    const segment = state.current;
    const relativeFrame = scene.cursorFrames - segment.startFrame;

    if (namedCycle) {
      const cycleDrawings = namedCycle.drawings || [];
      if (cycleDrawings.length === 0) {
        throw new ScriptError(lineNumber, `${displayName} cycle "${drawing}" on ${slotName} has no drawings.`);
      }
      const missing = cycleDrawings.filter((d) => !drawings.has(d));
      if (missing.length > 0) {
        throw new ScriptError(
          lineNumber,
          `${displayName} cycle "${drawing}" on ${slotName} references missing drawing(s) ${missing.join(", ")}. Available: ${[...drawings.keys()].join(", ") || "(none)"}`
        );
      }
      const cycleFps = namedCycle.fps;
      if (!Number.isFinite(cycleFps) || cycleFps <= 0) {
        throw new ScriptError(lineNumber, `${displayName} cycle "${drawing}" on ${slotName} has an invalid fps.`);
      }
      keyframe = { frame: relativeFrame, cycle: [...cycleDrawings], fps: cycleFps };
    } else if (drawings.has(drawing)) {
      keyframe = { frame: relativeFrame, drawing };
    } else {
      const cycleNames = Object.keys(cycles);
      if (cycleNames.length > 0) {
        throw new ScriptError(
          lineNumber,
          `${displayName} has no ${slotName} drawing or cycle "${drawing}". Available drawings: ${[...drawings.keys()].join(", ") || "(none)"}. Available cycles: ${cycleNames.join(", ")}`
        );
      }
      throw new ScriptError(
        lineNumber,
        `${displayName} has no ${slotName} drawing "${drawing}". Available: ${[...drawings.keys()].join(", ") || "(none)"}`
      );
    }

    this._writeSlotKeyframe(segment, owner, slotName, keyframe);
    state.activeSlots.set(slotStateKey(owner, slotName), {
      ownerType: owner.ownerType,
      childId: owner.childId,
      slotName,
      drawing: keyframe.drawing,
      cycle: keyframe.cycle ? [...keyframe.cycle] : undefined,
      fps: keyframe.fps,
      startedAtSceneFrame: keyframe.cycle ? scene.cursorFrames : undefined,
    });
  }

  _writeSlotKeyframe(segment, owner, slotName, keyframe) {
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
    const existingIdx = bucket.findIndex((k) => k.frame === keyframe.frame);
    if (existingIdx !== -1) bucket[existingIdx] = keyframe;
    else bucket.push(keyframe);
  }

  /**
   * Seed a newly opened layer with the character's last active drawing/cycle
   * for every slot the forking tag did not itself set. Cycles are rotated so
   * the drawing that was showing at the cut is first (phase-continuous at
   * the drawing boundary; intra-drawing leftover cannot be encoded because
   * keyframe frames cannot be negative).
   */
  _carryActiveSlots(state, scene, skipSlotNames) {
    for (const active of state.activeSlots.values()) {
      if (skipSlotNames.has(active.slotName)) continue;
      const owner = { ownerType: active.ownerType, childId: active.childId };
      this._writeSlotKeyframe(state.current, owner, active.slotName, keyframeFromActive(active, scene));
    }
  }

  _warnNoteLooksLikeAssignments(lineNumber, tagName, note) {
    if (!noteHasKeyValue(note)) return;
    const extras = note.split(/\s+/).filter((word) => KEY_VALUE_RE.test(word));
    this.warnings.push(
      `Line ${lineNumber}: [${tagName}: ...] free-text note contains key=value (${extras.join(", ")}) which was ignored. Bare flags like "flip" can sit anywhere among key=value tokens; only text after the first non-flag word is a note.`
    );
  }

  _findChild(config, partName) {
    const children = (config && config.children) || [];
    return (
      children.find((c) => c.id === partName) ||
      children.find((c) => c.id.toLowerCase() === String(partName).toLowerCase()) ||
      null
    );
  }

  _availableParts(config) {
    return ((config && config.children) || []).map((c) => c.id);
  }

  _getChildRotation(state, childId) {
    if (state.childRotations.has(childId)) return state.childRotations.get(childId);
    const child = this._findChild(state.config, childId);
    const rotation = child && child.rotation !== undefined ? child.rotation : 0;
    state.childRotations.set(childId, rotation);
    return rotation;
  }

  _addTransformKeyframe(segment, keyframe) {
    const existing = segment.transformKeyframes.find((k) => k.frame === keyframe.frame);
    if (existing) {
      Object.assign(existing, keyframe);
      return;
    }
    segment.transformKeyframes.push(keyframe);
  }

  _addRotationKeyframe(segment, childId, keyframe) {
    let list = segment.childRotationKeyframes.get(childId);
    if (!list) {
      list = [];
      segment.childRotationKeyframes.set(childId, list);
    }
    const existing = list.find((k) => k.frame === keyframe.frame);
    if (existing) {
      Object.assign(existing, keyframe);
      return;
    }
    list.push(keyframe);
  }

  _requireCharacterForMotion(token, tagName) {
    const scene = this._requireScene(token.lineNumber, tagName);
    const { character: scriptName, kv, note } = parseActionTag(token.body);
    this._warnNoteLooksLikeAssignments(token.lineNumber, tagName, note);
    if (!scriptName) throw new ScriptError(token.lineNumber, `[${tagName}: ...] needs a character name.`);
    const characterId = this._resolveCharacterIdOrThrow(scriptName, token.lineNumber);
    if (!scene.castOrder.includes(characterId)) {
      scene.castOrder.push(characterId);
    }
    const state = this._ensureCharacterPositioned(scene, characterId, token.lineNumber);
    return { scene, state, characterId, kv };
  }

  _collectPartAngles(kv, reservedKeys, state, lineNumber, tagName) {
    const parts = [];
    for (const [key, value] of Object.entries(kv)) {
      if (reservedKeys.has(key)) continue;
      const child = this._findChild(state.config, key);
      if (!child) {
        throw new ScriptError(
          lineNumber,
          `Unknown part "${key}" on ${state.config.display_name || state.characterId}. Available: ${this._availableParts(state.config).join(", ") || "(none)"}`
        );
      }
      const degrees = parseNumberValue(value, lineNumber, `${tagName} ${key}`);
      parts.push({ childId: child.id, degrees });
    }
    if (parts.length === 0) {
      throw new ScriptError(
        lineNumber,
        `[${tagName}: ...] needs at least one part angle (e.g. right_arm=30). Available: ${this._availableParts(state.config).join(", ") || "(none)"}`
      );
    }
    return parts;
  }

  // ---- [Move: ...] -------------------------------------------------------

  _handleMove(token) {
    const { scene, state, kv } = this._requireCharacterForMotion(token, "Move");
    if (kv.to === undefined) {
      throw new ScriptError(token.lineNumber, `[Move: ...] needs to=<mark> or to=<x,y>.`);
    }

    const overSeconds = parseSecondsSpec(kv.over, token.lineNumber, "over");
    const ease = parseEaseValue(kv.ease, token.lineNumber);
    const wait = parseWaitValue(kv.wait, token.lineNumber);
    const durationFrames = framesFromSeconds(overSeconds, this.fps);
    if (durationFrames <= 0) {
      throw new ScriptError(token.lineNumber, `Invalid over "${kv.over}" -- duration rounds to 0 frames at ${this.fps} fps.`);
    }

    const segment = state.current;
    const from = segment.transform;
    let toX;
    let toY;
    let toScale;
    let markName = segment.markName;

    const xy = parseXyPair(kv.to);
    if (xy) {
      toX = xy.x;
      toY = xy.y;
      if (kv.scale !== undefined) {
        toScale = parseNumberValue(kv.scale, token.lineNumber, "scale");
        if (toScale <= 0) {
          throw new ScriptError(token.lineNumber, `Invalid scale "${kv.scale}" -- must be greater than 0.`);
        }
      } else {
        toScale = from.scale;
      }
      markName = null; // no longer standing on a named mark
    } else {
      const mark = this._resolveMark(scene, kv.to, token.lineNumber);
      toX = mark.x;
      toY = mark.y;
      if (kv.scale !== undefined) {
        toScale = parseNumberValue(kv.scale, token.lineNumber, "scale");
        if (toScale <= 0) {
          throw new ScriptError(token.lineNumber, `Invalid scale "${kv.scale}" -- must be greater than 0.`);
        }
      } else if (mark.scale !== undefined) {
        toScale = mark.scale;
      } else {
        toScale = from.scale;
      }
      markName = kv.to;
    }

    const startRel = scene.cursorFrames - segment.startFrame;
    const endRel = startRel + durationFrames;

    this._addTransformKeyframe(segment, {
      frame: startRel,
      x: from.x,
      y: from.y,
      scale: from.scale,
      ease,
    });
    this._addTransformKeyframe(segment, {
      frame: endRel,
      x: toX,
      y: toY,
      scale: toScale,
    });

    segment.transform = { ...from, x: toX, y: toY, scale: toScale };
    segment.markName = markName;
    this._applyWait(scene, durationFrames, wait);
  }

  // ---- [Pose: ...] -------------------------------------------------------

  _handlePose(token) {
    const { scene, state, kv } = this._requireCharacterForMotion(token, "Pose");
    const reserved = new Set(["over", "ease", "wait"]);
    const parts = this._collectPartAngles(kv, reserved, state, token.lineNumber, "Pose");
    const overSeconds = parseSecondsSpec(kv.over, token.lineNumber, "over");
    const ease = parseEaseValue(kv.ease, token.lineNumber);
    const wait = parseWaitValue(kv.wait, token.lineNumber);
    const durationFrames = framesFromSeconds(overSeconds, this.fps);
    if (durationFrames <= 0) {
      throw new ScriptError(token.lineNumber, `Invalid over "${kv.over}" -- duration rounds to 0 frames at ${this.fps} fps.`);
    }

    const segment = state.current;
    const startRel = scene.cursorFrames - segment.startFrame;
    const endRel = startRel + durationFrames;

    for (const part of parts) {
      const from = this._getChildRotation(state, part.childId);
      this._addRotationKeyframe(segment, part.childId, { frame: startRel, rotation: from, ease });
      this._addRotationKeyframe(segment, part.childId, { frame: endRel, rotation: part.degrees });
      state.childRotations.set(part.childId, part.degrees);
    }

    this._applyWait(scene, durationFrames, wait);
  }

  // ---- [Swing: ...] ------------------------------------------------------

  _handleSwing(token) {
    const { scene, state, kv } = this._requireCharacterForMotion(token, "Swing");
    const reserved = new Set(["period", "for", "wait", "ease"]);
    const parts = this._collectPartAngles(kv, reserved, state, token.lineNumber, "Swing");
    const periodSeconds = parseSecondsSpec(kv.period, token.lineNumber, "period");
    const forSeconds = parseSecondsSpec(kv.for, token.lineNumber, "for");
    const wait = parseWaitValue(kv.wait, token.lineNumber);
    if (kv.ease !== undefined) parseEaseValue(kv.ease, token.lineNumber); // validate if given; swings always use inout

    const periodFrames = framesFromSeconds(periodSeconds, this.fps);
    const durationFrames = framesFromSeconds(forSeconds, this.fps);
    if (periodFrames <= 0) {
      throw new ScriptError(token.lineNumber, `Invalid period "${kv.period}" -- duration rounds to 0 frames at ${this.fps} fps.`);
    }
    if (durationFrames <= 0) {
      throw new ScriptError(token.lineNumber, `Invalid for "${kv.for}" -- duration rounds to 0 frames at ${this.fps} fps.`);
    }

    const segment = state.current;
    const startRel = scene.cursorFrames - segment.startFrame;

    for (const part of parts) {
      const current = this._getChildRotation(state, part.childId);
      const keys = swingRotationKeyframes(current, part.degrees, periodFrames, durationFrames, startRel);
      for (const key of keys) this._addRotationKeyframe(segment, part.childId, key);
      state.childRotations.set(part.childId, current); // ends back at the start angle
    }

    this._applyWait(scene, durationFrames, wait);
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

    const endFrames = Math.max(scene.cursorFrames, scene.horizonFrames);
    const extraHold = Math.max(0, endFrames - scene.cursorFrames);
    const duration =
      anyDialogue
        ? { from_dialogue: true, padding_frames: DEFAULT_SCENE_PADDING_FRAMES + extraHold }
        : { frames: Math.max(endFrames, this.fps) }; // at least 1s for a silent/establishing scene

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
    const assetRel = `characters/${state.characterId}/${config.asset || "body.png"}`;
    const bodyAsset = assetLibrary.resolveAsset(this.projectDir, this.globalAssetsDir, assetRel);
    if (!bodyAsset) {
      const name = config.display_name || state.characterId;
      throw new ScriptError(
        segment._lineNumber,
        `${name} is missing base asset "${config.asset || "body.png"}". For a body-as-slot character, use a blank/transparent PNG as the base asset and put the drawings on slots.body.`
      );
    }

    const layer = {
      id: segment.layerId,
      character_id: state.characterId,
      asset: bodyAsset.timelinePath,
      z: segment.z,
      transform: segment.openingTransform || segment.transform,
    };
    if (segment.transformKeyframes && segment.transformKeyframes.length > 0) {
      layer.transform_keyframes = [...segment.transformKeyframes].sort((a, b) => a.frame - b.frame);
    }
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
      const rotMap = segment.closingChildRotations || state.childRotations;
      layer.children = config.children.map((child) =>
        this._buildChildJson(
          state.characterId,
          child,
          segment.childSlotKeyframes.get(child.id),
          segment.childRotationKeyframes.get(child.id),
          rotMap.has(child.id) ? rotMap.get(child.id) : child.rotation
        )
      );
    }

    return layer;
  }

  _buildSlotJson(characterId, slotName, slotConfig, keyframes) {
    if (slotName === "mouth") {
      const images = this._scanSlotImages(characterId, slotConfig);
      const mouth = { offset: slotConfig.offset || { x: 0, y: 0 }, images, lipsync: { source: "dialogue" } };
      if (slotConfig.visible_when) mouth.visible_when = slotConfig.visible_when;
      return mouth;
    }
    const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
    if (sorted.length === 0 || sorted[0].frame !== 0) {
      sorted.unshift({ frame: 0, drawing: slotConfig.default_drawing });
    }
    const images = this._scanSlotImages(characterId, slotConfig);
    const slot = { offset: slotConfig.offset || { x: 0, y: 0 }, images, keyframes: sorted };
    if (slotConfig.visible_when) slot.visible_when = slotConfig.visible_when;
    return slot;
  }

  _scanSlotImages(characterId, slotConfig) {
    const drawingsDir = `characters/${characterId}/${slotConfig.drawings_dir}`;
    const drawings = assetLibrary.scanDrawingsDir(this.projectDir, this.globalAssetsDir, drawingsDir);
    const images = {};
    for (const [name, file] of drawings.entries()) images[name] = file.timelinePath;
    return images;
  }

  _buildChildJson(characterId, childConfig, slotKeyframesMap, rotationKeyframes, liveRotation) {
    const asset = assetLibrary.resolveAsset(this.projectDir, this.globalAssetsDir, `characters/${characterId}/${childConfig.asset}`);
    if (!asset) {
      throw new ScriptError(null, `Character "${characterId}" child "${childConfig.id}" is missing asset "${childConfig.asset}".`);
    }
    const child = {
      id: childConfig.id,
      asset: asset.timelinePath,
      z: childConfig.z,
      offset: childConfig.offset || { x: 0, y: 0 },
    };
    if (childConfig.parent) child.parent = childConfig.parent;
    if (childConfig.pivot) child.pivot = childConfig.pivot;
    if (childConfig.scale !== undefined) child.scale = childConfig.scale;
    if (childConfig.flip_x !== undefined) child.flip_x = childConfig.flip_x;
    const rotation = liveRotation !== undefined ? liveRotation : childConfig.rotation;
    if (rotation !== undefined) child.rotation = rotation;
    if (rotationKeyframes && rotationKeyframes.length > 0) {
      child.rotation_keyframes = [...rotationKeyframes].sort((a, b) => a.frame - b.frame);
    }

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

module.exports = {
  parseScript,
  ScriptParser,
  slugify,
  estimateDurationSeconds,
  framesFromSeconds,
  swingRotationKeyframes,
};
