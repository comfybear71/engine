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
 * position (it doesn't advance it). [Move:]/[Pose:]/[Swing:]/[Do:] write
 * keyframes on the current layer; wait=true (default) advances the cursor
 * like [Pause], wait=false leaves it so following lines run during the motion.
 * [Do:] plays an actions/*.json cycle in place (no travel, no flip).
 * [Camera:] writes scene-level camera keyframes the same way.
 * [Insert: image=<rel> at_time=<frame> for=<frames>|to=<last frame>] holds a
 * still PNG over that range (a cutaway / insert shot). It does not advance
 * the shared cursor.
 * [Audio: Name file=<label>] places an import-audio track (WAV + Rhubarb
 * cues + optional words.json) as that character's dialogue at the cursor
 * and advances by the real file duration.
 *
 * Optional at_time= / start= (seconds like "2s" or a frame count like "48")
 * pins that one event to an explicit scene-local start. The shared cursor
 * still advances from its current value (wait=true / dialogue / audio), so
 * moving one block does not ripple-shift later lines. Omit the attribute
 * and timing is unchanged (script order + wait=).
 *
 * Dialogue and [Audio:] accept trim_in= / trim_out= (seconds or frames into
 * the source file). Playback, Rhubarb cues, words, and the cursor advance
 * use the trimmed window. Instant pins accept optional hold= (or over=) to
 * lock a fixed length instead of stretching to the next pin.
 *
 * A character gets exactly one Layer per *cut* they hold in a scene:
 * an [Action: ... at=/flip=/scale=/z=] that actually changes their resolved
 * transform closes the current layer "segment" and opens a new one with the
 * same character_id, back-to-back in time. [Move:] does *not* fork a layer --
 * it adds transform_keyframes on the current one. Flip still forks (flip_x
 * is not keyframed); the new layer starts at the post-Move position.
 *
 * Location props from staging.json `props` are the same kind of layer
 * (prop_id instead of character_id), drawn in z order with characters.
 * [Prop:] adds/moves/hides them; [Layer: Name z=N] changes a character's
 * or prop's z mid-shot.
 */

const fs = require("fs");
const path = require("path");

const { tokenize } = require("./tokenizer");
const {
  parseActionTag,
  parseKvTag,
  noteHasKeyValue,
  parseCastList,
  parsePauseValue,
  parseAtTimeSpec,
  parseViewValue,
  parseSecondsSpec,
  HEAD_VIEWS,
  parseEaseValue,
  parseWaitValue,
  parseNumberValue,
  parseXyPair,
  KEY_VALUE_RE,
} = require("./actionTag");
const { ScriptError } = require("./errors");
const assetLibrary = require("./assetLibrary");
const actionLibrary = require("./actionLibrary");
const { probeDurationSeconds } = require("./ffprobeDuration");
const { findOverlapWarnings, findMouthSheetErrors, findMissingPropAssets, findSharedLibraryWarnings, findRigHeadAssetErrors } = require("./lint");
const { resolveImportedTrack, wordsToSentences, transcriptFromWords } = require("../importAudio");
const { computeSyncState } = require("../voices/lipSync");

const WORDS_PER_SECOND = 2.5;
const ESTIMATE_PAD_SECONDS = 0.3;
const DEFAULT_SCENE_PADDING_FRAMES = 12;
const DEFAULT_CANVAS_WIDTH = 1920;
const DEFAULT_CANVAS_HEIGHT = 1080;
const RESERVED_SLOT_NAMES = new Set(["mouth"]); // dialogue-driven only, never settable via [Action: ...]
const HIDE_DRAWING = "none";

function usableSlotDrawing(value) {
  const name = String(value == null ? "" : value).trim();
  return name || null;
}
const CAMERA_KEYS = new Set(["zoom", "pan", "tilt", "to", "over", "ease", "wait", "reset", "at_time", "start"]);
const TIMING_KEYS = new Set(["at_time", "start"]);
const HOLD_KEYS = new Set(["over", "hold"]);
const TRIM_KEYS = new Set(["trim_in", "trim_out"]);
const AUDIO_KEYS = new Set(["file", "lines", "view", "at_time", "start", "trim_in", "trim_out"]);
const DO_KEYS = new Set(["action", "for", "wait", "at_time", "start", "prop"]);
const INSERT_KEYS = new Set(["image", "file", "src", "at_time", "start", "for", "over", "to", "z", "x", "y", "scale", "anchor"]);
const BUILTIN_REST_ACTION = "rest";
const PROP_PLACEHOLDER = "{prop}";

function slugInsertId(text) {
  return (
    String(text || "")
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "shot"
  );
}

function insertDurationFrames(startFrame, endFrameInclusive) {
  const start = Math.max(0, Math.floor(Number(startFrame) || 0));
  const last = Math.max(start, Math.floor(Number(endFrameInclusive) || start));
  return { startFrame: start, endFrame: last + 1, frames: last - start + 1, lastFrame: last };
}

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
  constructor(sceneId, fps, canvas) {
    this.sceneId = sceneId;
    this.fps = fps;
    this.canvas = canvas;
    this.location = null;
    this.staging = null;
    this.background = null;
    this.castOrder = []; // character ids, in [Cast: ...]/first-appearance order
    this.characters = new Map(); // character_id -> CharacterSceneState
    this.props = new Map(); // prop_id -> PropSceneState
    this.cursorFrames = 0;
    this.horizonFrames = 0; // latest animation end, including wait=false motions
    this.lineCounter = 0; // for audio/<scene>/<nnn>_<char>.wav naming
    this.camera = { x: canvas.width / 2, y: canvas.height / 2, zoom: 1.0 };
    this.cameraKeyframes = [];
    this.inserts = [];
  }
}

class CharacterSceneState {
  constructor(characterId, config) {
    this.characterId = characterId;
    this.config = config;
    this.segments = []; // finished segments (plain JSON layer objects)
    this.current = null; // the open segment draft, or null
    this.childRotations = new Map(); // childId -> current degrees (survives layer forks)
    this.groupRotations = new Map(); // groupName -> current degrees (survives layer forks)
    this.bodyRotation = 0; // layer transform.rotation (whole-body lean; survives forks)
    // Last Action-set drawing/cycle per slot, so a forked layer can continue
    // it instead of snapping back to default_drawing.
    this.activeSlots = new Map(); // slotStateKey -> { ownerType, childId?, slotName, drawing?, cycle?, fps?, startedAtSceneFrame? }
    this.currentView = "front"; // head/mouth set for subsequent dialogue until [View:] or view=
  }
}

class PropSceneState {
  constructor(propId, def) {
    this.propId = propId;
    this.def = def; // { assetRel, x, y, scale, z, anchor }
    this.segments = [];
    this.current = null;
    this.lastPose = null; // last transform/z/mark, so [Prop: show] resumes there
    this.drawing = "default";
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
    viewKeyframes: [], // [{frame, view}] held-until-changed head/mouth/eyes view
    childRotationKeyframes: new Map(), // childId -> [{frame, rotation, ease?}]
    groupRotationKeyframes: new Map(), // groupName -> [{frame, rotation, ease?}]
    openingTransform: { ...transform },
    drawing: undefined,
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
    this.canvas = {
      width: (options.canvas && options.canvas.width) || DEFAULT_CANVAS_WIDTH,
      height: (options.canvas && options.canvas.height) || DEFAULT_CANVAS_HEIGHT,
    };
    this.characterLibrary = new CharacterLibrary(projectDir, globalAssetsDir);
    this.scenes = [];
    this.lines = [];
    this.warnings = [];
    this.errors = [];
    this._usedSceneIds = new Set();
    this.usedCharacters = new Map(); // characterId -> character.json (used in this script)
    this.usedProps = []; // declared/used location props, for the missing-asset lint
    this.occupancy = []; // per-segment mark/z intervals, for the overlap lint
    this.scene = null; // current SceneContext
    this.laneEvents = []; // Studio timeline blocks (scene-local frames + script line)
    this.sceneLengths = []; // { id, frames } in parse order, for global offsets
  }

  _laneTiming(token, kv) {
    const kind =
      token.kind === "dialogue"
        ? "dialogue"
        : token.kind === "audio"
          ? "audio"
          : token.kind === "swing" || token.kind === "do"
            ? "for"
            : token.kind === "move" || token.kind === "pose" || token.kind === "camera"
              ? "over"
              : "pin";
    const explicit = kv && kv.at_time !== undefined ? "at_time" : kv && kv.start !== undefined ? "start" : null;
    const durationAttr =
      kind === "over"
        ? "over"
        : kind === "for"
          ? "for"
          : kind === "pin" && kv && kv.hold !== undefined
            ? "hold"
            : kind === "pin" && kv && kv.over !== undefined
              ? "over"
              : null;
    return {
      kind,
      tag: token.kind,
      attr: explicit || durationAttr,
      movable: true,
    };
  }

  _specToSeconds(spec, fps) {
    if (spec.frames !== undefined) return spec.frames / Math.max(1, fps);
    return spec.seconds;
  }

  _audioWindow(kv, sourceSeconds, fps, lineNumber) {
    const source = Math.max(0, Number(sourceSeconds) || 0);
    let inSec = 0;
    let outSec = source;
    if (kv && kv.trim_in !== undefined) {
      inSec = this._specToSeconds(parseAtTimeSpec(kv.trim_in, lineNumber, "trim_in"), fps);
    }
    if (kv && kv.trim_out !== undefined) {
      outSec = this._specToSeconds(parseAtTimeSpec(kv.trim_out, lineNumber, "trim_out"), fps);
    }
    if (!(inSec >= 0) || !(outSec >= 0)) {
      throw new ScriptError(lineNumber, `Invalid trim_in/trim_out -- must be 0 or greater.`);
    }
    if (inSec > source + 1e-6) {
      throw new ScriptError(
        lineNumber,
        `trim_in ${kv.trim_in} is past the source length (${source.toFixed(3)}s).`
      );
    }
    if (outSec > source + 1e-6) {
      throw new ScriptError(
        lineNumber,
        `trim_out ${kv.trim_out} is past the source length (${source.toFixed(3)}s).`
      );
    }
    if (outSec <= inSec) {
      throw new ScriptError(lineNumber, `trim_out must be greater than trim_in.`);
    }
    const durationSec = outSec - inSec;
    const durationFrames = framesFromSeconds(durationSec, fps);
    if (durationFrames < 1) {
      throw new ScriptError(
        lineNumber,
        `Trimmed duration rounds to 0 frames at ${fps} fps -- need at least 1 frame.`
      );
    }
    return {
      inSec,
      outSec,
      durationSec,
      durationFrames,
      inFrames: framesFromSeconds(inSec, fps),
      outFrames: framesFromSeconds(outSec, fps),
      sourceFrames: framesFromSeconds(source, fps),
    };
  }

  _readWords(relPath) {
    if (!relPath) return [];
    const candidates = [];
    if (/\.wav$/i.test(relPath)) candidates.push(relPath.replace(/\.wav$/i, ".words.json"));
    candidates.push(`${relPath}.words.json`);
    for (const rel of candidates) {
      const abs = path.isAbsolute(rel) ? rel : path.join(this.projectDir, rel);
      try {
        if (!fs.existsSync(abs)) continue;
        const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
        const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed.words) ? parsed.words : [];
        return raw
          .map((item) => ({
            word: String(item.word || item.text || "").trim(),
            start: Number(item.start) || 0,
            end: Number(item.end) || 0,
          }))
          .filter((item) => item.word && item.end > item.start);
      } catch {
        /* try the next candidate */
      }
    }
    return [];
  }

  _wordsInWindow(words, inSec, outSec) {
    return (words || []).filter((word) => word.end > inSec && word.start < outSec);
  }

  /** Scene-local start: at_time= / start= if present, else the shared cursor. */
  _eventStartFrame(kv, scene, lineNumber) {
    const hasAt = kv && kv.at_time !== undefined;
    const hasStart = kv && kv.start !== undefined;
    if (!hasAt && !hasStart) return scene.cursorFrames;
    const label = hasAt ? "at_time" : "start";
    const spec = parseAtTimeSpec(hasAt ? kv.at_time : kv.start, lineNumber, label);
    if (spec.frames !== undefined) return spec.frames;
    return Math.max(0, Math.round(spec.seconds * this.fps));
  }

  /** Run `fn` with the scene cursor temporarily at `startFrame`, then restore. */
  _runAtEventTime(scene, startFrame, fn) {
    const saved = scene.cursorFrames;
    scene.cursorFrames = startFrame;
    try {
      return fn(saved);
    } finally {
      scene.cursorFrames = saved;
    }
  }

  _emitLane({
    lane,
    token,
    startFrame,
    endFrame,
    label,
    subject,
    rel,
    keys,
    subjectKind,
    kv,
    sourceStartFrame,
    cues,
    view,
    marriedId,
    audioRel,
    cuesRel,
    syncText,
    trim,
    sourceDurationFrames,
    words,
  }) {
    if (!this.scene) return;
    const start = Math.max(0, startFrame);
    let end = Math.max(start, endFrame == null ? start : endFrame);
    if (end <= start && kv) {
      const spec = kv.hold !== undefined ? kv.hold : kv.over;
      const key = kv.hold !== undefined ? "hold" : "over";
      if (spec !== undefined) {
        const hold = framesFromSeconds(parseSecondsSpec(spec, token.lineNumber, key), this.fps);
        if (hold >= 1) end = start + hold;
      }
    }
    const sourceStart = sourceStartFrame == null ? start : Math.max(0, sourceStartFrame);
    const spokenText = syncText == null ? "" : String(syncText);
    const sync =
      lane === "dialogue" && cuesRel
        ? computeSyncState({
            projectDir: this.projectDir,
            cuesRel,
            wavRel: audioRel,
            text: spokenText,
          })
        : null;
    this.laneEvents.push({
      lane,
      tag: token.kind,
      keys: Array.isArray(keys) ? keys : [],
      subjectKind: subjectKind || null,
      sceneId: this.scene.sceneId,
      scriptLine: token.lineNumber,
      startFrame: start,
      endFrame: end,
      sourceStartFrame: sourceStart,
      label,
      subject: subject || null,
      rel: rel || null,
      timing: this._laneTiming(token, kv || {}),
      cues: Array.isArray(cues) ? cues : [],
      view: view || null,
      marriedId: marriedId || null,
      trim: trim || { inFrames: 0, outFrames: sourceDurationFrames || 0 },
      sourceDurationFrames: sourceDurationFrames || 0,
      words: Array.isArray(words) ? words : [],
      audioRel: audioRel || null,
      cuesRel: cuesRel || null,
      syncText: spokenText || null,
      sync,
    });
  }

  _marriedId(token) {
    if (!this.scene) return null;
    return `line:${this.scene.sceneId}:${token.lineNumber}`;
  }

  _readMouthCues(relPath) {
    if (!relPath) return [];
    const abs = path.isAbsolute(relPath) ? relPath : path.join(this.projectDir, relPath);
    try {
      if (!fs.existsSync(abs)) return [];
      const data = JSON.parse(fs.readFileSync(abs, "utf8"));
      const raw = Array.isArray(data.mouthCues) ? data.mouthCues : [];
      return raw
        .map((cue) => ({
          shape: String(cue.value || cue.shape || "X"),
          start: Number(cue.start) || 0,
          end: Number(cue.end) || 0,
          pinned: Boolean(cue.pinned),
        }))
        .filter((cue) => cue.end > cue.start);
    } catch {
      return [];
    }
  }

  _sliceMouthCues(cues, fromSec, toSec) {
    return (cues || [])
      .filter((cue) => cue.end > fromSec && cue.start < toSec)
      .map((cue) => ({
        shape: cue.shape,
        start: Math.max(0, cue.start - fromSec),
        end: Math.max(0, Math.min(toSec, cue.end) - fromSec),
        pinned: Boolean(cue.pinned),
      }))
      .filter((cue) => cue.end > cue.start);
  }

  _resolveLineView(kv, state, lineNumber) {
    if (kv && kv.view !== undefined) return parseViewValue(kv.view, lineNumber);
    return state && state.currentView && state.currentView !== "front" ? state.currentView : null;
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
    this.warnings.push(...findSharedLibraryWarnings(timeline));
    return {
      timeline,
      lines: this.lines,
      warnings: this.warnings,
      errors: this.errors,
      laneEvents: this.laneEvents,
      sceneLengths: this.sceneLengths,
    };
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
      case "prop":
        this._handleProp(token);
        return;
      case "layer":
        this._handleLayer(token);
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
      case "do":
        this._handleDo(token);
        return;
      case "camera":
        this._handleCamera(token);
        return;
      case "pause":
        this._handlePause(token);
        return;
      case "audio":
        await this._handleImportedAudio(token);
        return;
      case "view":
        this._handleView(token);
        return;
      case "insert":
        this._handleInsert(token);
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
    this.scene = new SceneContext(id, this.fps, this.canvas);
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
    this._placeDeclaredProps(scene, token.lineNumber);
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
    if (state.config && !state._childGraphChecked) {
      actionLibrary._validateChildGraph(state.config.children, {
        lineNumber,
        name: (state.config.display_name || state.characterId),
      });
      state._childGraphChecked = true;
    }
    if (state.current) return state;

    const markName = this._autoAssignMark(scene, characterId);
    const mark = this._resolveMark(scene, markName, lineNumber);
    this._openSegment(scene, state, { markSource: "auto", mark, markName, actionKv: {} }, lineNumber);
    return state;
  }

  _normalizePropDef(scene, name, raw, lineNumber) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ScriptError(lineNumber, `Prop "${name}" in staging.json must be an object with asset/x/y/z.`);
    }
    const asset = raw.asset || `props/${name}.png`;
    const assetRel = `backgrounds/${scene.location}/${asset}`;
    const drawings = { default: asset };
    if (raw.drawings && typeof raw.drawings === "object" && !Array.isArray(raw.drawings)) {
      for (const [drawingName, rel] of Object.entries(raw.drawings)) {
        const key = String(drawingName || "").trim();
        const pathRel = typeof rel === "string" ? rel.trim() : "";
        if (!key) {
          throw new ScriptError(lineNumber, `Prop "${name}" drawings has an empty name.`);
        }
        if (!pathRel) {
          throw new ScriptError(lineNumber, `Prop "${name}" drawing "${key}" needs a path relative to the location folder.`);
        }
        drawings[key] = pathRel;
      }
    }
    if (!drawings.default) drawings.default = asset;
    const anchor = assetLibrary.normalizeAnchor(raw.anchor === undefined ? "bottom-center" : raw.anchor);
    if (!anchor) {
      throw new ScriptError(
        lineNumber,
        `Prop "${name}" has invalid anchor "${raw.anchor}". Available: ${[...assetLibrary.ANCHOR_NAMES].join(", ")}`
      );
    }
    let scale = 1.0;
    if (raw.scale !== undefined) {
      scale = Number(raw.scale);
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new ScriptError(lineNumber, `Prop "${name}" has invalid scale "${raw.scale}" -- must be greater than 0.`);
      }
    }
    let z = 0;
    if (raw.z !== undefined) {
      z = parseInt(raw.z, 10);
      if (!Number.isFinite(z)) {
        throw new ScriptError(lineNumber, `Prop "${name}" has invalid z "${raw.z}" -- expected an integer.`);
      }
    }
    const x = raw.x !== undefined ? Number(raw.x) : undefined;
    const y = raw.y !== undefined ? Number(raw.y) : undefined;
    if (x !== undefined && !Number.isFinite(x)) {
      throw new ScriptError(lineNumber, `Prop "${name}" has invalid x "${raw.x}" -- expected a number.`);
    }
    if (y !== undefined && !Number.isFinite(y)) {
      throw new ScriptError(lineNumber, `Prop "${name}" has invalid y "${raw.y}" -- expected a number.`);
    }
    return { name, asset, assetRel, drawings, x, y, scale, z, anchor, location: scene.location };
  }

  _placeDeclaredProps(scene, lineNumber) {
    const declared = (scene.staging && scene.staging.props) || {};
    for (const [rawName, raw] of Object.entries(declared)) {
      const def = this._normalizePropDef(scene, rawName, raw, lineNumber);
      const present = [...assetLibrary.scanDrawingsDir(this.projectDir, this.globalAssetsDir, `backgrounds/${scene.location}/props`).keys()].sort();
      def.resolvedDrawings = {};
      for (const [drawingName, rel] of Object.entries(def.drawings || { default: def.asset })) {
        const drawingRel = `backgrounds/${scene.location}/${rel}`;
        this.usedProps.push({
          name: def.name,
          location: scene.location,
          assetRel: drawingRel,
          drawing: drawingName,
          lineNumber,
        });
        const resolved = assetLibrary.resolveAsset(this.projectDir, this.globalAssetsDir, drawingRel);
        if (!resolved) {
          throw new ScriptError(
            lineNumber,
            `Prop "${def.name}" is missing ${drawingName === "default" ? "asset" : `drawing "${drawingName}"`} "${drawingRel}". Available: ${present.join(", ") || "(none)"}`
          );
        }
        def.resolvedDrawings[drawingName] = resolved;
      }
      def.resolved = def.resolvedDrawings.default;
      const state = new PropSceneState(def.name, def);
      scene.props.set(def.name, state);
      if (def.x !== undefined && def.y !== undefined) {
        this._openPropSegment(
          scene,
          state,
          {
            transform: { x: def.x, y: def.y, scale: def.scale, anchor: def.anchor, flip_x: false },
            z: def.z,
            markName: null,
          },
          lineNumber
        );
      }
    }
  }

  _knownPropNames(scene) {
    return [...scene.props.keys()];
  }

  _findPropState(scene, scriptName) {
    if (!scene || !scene.props) return null;
    const exact = scene.props.get(scriptName);
    if (exact) return exact;
    const lower = String(scriptName).toLowerCase();
    for (const [name, state] of scene.props) {
      if (name.toLowerCase() === lower) return state;
    }
    return null;
  }

  _resolvePropState(scene, scriptName, lineNumber) {
    const state = this._findPropState(scene, scriptName);
    if (state) return state;
    throw new ScriptError(
      lineNumber,
      `Unknown prop "${scriptName}" for location "${scene.location}". Available: ${this._knownPropNames(scene).join(", ") || "(none)"}`
    );
  }

  _openPropSegment(scene, state, { transform, z, markName, drawing }, lineNumber) {
    const segmentIndex = state.segments.length + 1;
    const layerId = segmentIndex === 1 ? state.propId : `${state.propId}_${segmentIndex}`;
    state.current = newSegmentDraft(layerId, scene.cursorFrames, transform, z, markName);
    state.current.drawing = drawing || state.drawing || "default";
    state.drawing = state.current.drawing;
    state.current._lineNumber = lineNumber;
    state.lastPose = { transform: { ...transform }, z, markName, drawing: state.current.drawing };
  }

  _resolvePropPose(scene, state, kv, lineNumber) {
    const current = state.current;
    const prior = current
      ? { transform: current.transform, z: current.z, markName: current.markName, drawing: current.drawing }
      : state.lastPose;
    const def = state.def;
    let x = prior ? prior.transform.x : def.x;
    let y = prior ? prior.transform.y : def.y;
    let scale = prior ? prior.transform.scale : def.scale;
    let z = prior ? prior.z : def.z;
    let anchor = prior ? prior.transform.anchor : def.anchor;
    let markName = prior ? prior.markName : null;
    let drawing = prior && prior.drawing ? prior.drawing : state.drawing || "default";

    if (kv.at !== undefined) {
      const xy = parseXyPair(kv.at);
      if (xy) {
        x = xy.x;
        y = xy.y;
        markName = null;
      } else {
        const mark = this._resolveMark(scene, kv.at, lineNumber);
        x = mark.x;
        y = mark.y;
        markName = kv.at;
        if (kv.scale === undefined && mark.scale !== undefined) scale = mark.scale;
      }
    }
    if (kv.scale !== undefined) {
      scale = parseNumberValue(kv.scale, lineNumber, "scale");
      if (scale <= 0) {
        throw new ScriptError(lineNumber, `Invalid scale "${kv.scale}" -- must be greater than 0.`);
      }
    }
    if (kv.z !== undefined) {
      z = parseInt(kv.z, 10);
      if (!Number.isFinite(z)) {
        throw new ScriptError(lineNumber, `Invalid z "${kv.z}" -- expected an integer.`);
      }
    }
    if (kv.drawing !== undefined) {
      drawing = this._resolvePropDrawingName(state, kv.drawing, lineNumber);
    }
    if (x === undefined || y === undefined) {
      throw new ScriptError(
        lineNumber,
        `Prop "${state.propId}" needs a position (staging x/y, or at=<mark|x,y>).`
      );
    }
    return {
      transform: { x, y, scale, anchor: anchor || "bottom-center", flip_x: false },
      z,
      markName,
      drawing,
    };
  }

  _propDrawingNames(state) {
    return Object.keys((state.def && state.def.drawings) || { default: true });
  }

  _resolvePropDrawingName(state, raw, lineNumber) {
    const name = String(raw == null ? "" : raw).trim();
    const known = this._propDrawingNames(state);
    const match = known.find((item) => item === name) || known.find((item) => item.toLowerCase() === name.toLowerCase());
    if (!match) {
      throw new ScriptError(
        lineNumber,
        `Prop "${state.propId}" has no drawing "${name || ""}". Available: ${known.join(", ") || "(none)"}`
      );
    }
    return match;
  }

  _applyPropPose(scene, state, pose, lineNumber) {
    const current = state.current;
    const sameFrameAsSegmentStart = current && current.startFrame === scene.cursorFrames;
    if (current && sameFrameAsSegmentStart) {
      current.transform = pose.transform;
      current.openingTransform = { ...pose.transform };
      current.z = pose.z;
      current.markName = pose.markName;
      current.drawing = pose.drawing || current.drawing || "default";
      current._lineNumber = lineNumber;
      state.drawing = current.drawing;
      state.lastPose = { transform: { ...pose.transform }, z: pose.z, markName: pose.markName, drawing: current.drawing };
      return;
    }
    const drawing = pose.drawing || (current && current.drawing) || state.drawing || "default";
    if (
      !current ||
      transformsDiffer(current.transform, pose.transform) ||
      current.z !== pose.z ||
      (current.drawing || "default") !== drawing
    ) {
      this._closeCurrentSegment(state, scene.cursorFrames);
      this._openPropSegment(scene, state, { ...pose, drawing }, lineNumber);
    }
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

    const transform = { x, y, scale, flip_x: flipX, anchor: "bottom-center" };
    if (state.bodyRotation) transform.rotation = state.bodyRotation;
    return { transform, z };
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
    if (Object.prototype.hasOwnProperty.call(state, "lastPose")) {
      state.lastPose = {
        transform: { ...state.current.transform },
        z: state.current.z,
        markName: state.current.markName,
        drawing: state.current.drawing || state.drawing || "default",
      };
    }
    // Snapshot pose at close so a later [Pose] on the next layer cannot
    // rewrite this segment's static child rotations.
    if (state.childRotations) {
      state.current.closingChildRotations = new Map(state.childRotations);
    }
    if (state.groupRotations) {
      state.current.closingGroupRotations = new Map(state.groupRotations);
    }
    // A hide/replace at the same frame the segment opened never existed
    // on screen -- skip the zero-length layer.
    if (endFrame !== undefined && endFrame === state.current.startFrame) {
      state.current = null;
      return;
    }
    state.segments.push(state.current);
    state.current = null;
  }

  // ---- [Prop: ...] / [Layer: ...] -----------------------------------------

  _handleProp(token) {
    const scene = this._requireScene(token.lineNumber, "Prop");
    if (!scene.location) {
      throw new ScriptError(token.lineNumber, `[Prop: ...] needs a [Location: ...] first -- props are declared on the location.`);
    }
    const { character: scriptName, kv, note } = parseActionTag(token.body, { bareFlags: ["hide", "show"] });
    if (!scriptName) throw new ScriptError(token.lineNumber, "[Prop: ...] needs a prop name.");
    this._warnNoteLooksLikeAssignments(token.lineNumber, "Prop", note);
    if (kv.hide && kv.show) {
      throw new ScriptError(token.lineNumber, `[Prop: ...] cannot take both hide and show.`);
    }

    const state = this._resolvePropState(scene, scriptName, token.lineNumber);
    const wantHide = kv.hide === "true" || kv.hide === "1";
    const wantShow = kv.show === "true" || kv.show === "1";
    const hasPoseChange = kv.at !== undefined || kv.scale !== undefined || kv.z !== undefined || kv.drawing !== undefined;
    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);

    this._runAtEventTime(scene, eventStart, () => {
      if (wantHide) {
        this._closeCurrentSegment(state, scene.cursorFrames);
        this._emitLane({
          lane: "action",
          token,
          startFrame: scene.cursorFrames,
          endFrame: scene.cursorFrames,
          label: `${scriptName} hide`,
          subject: state.propId,
          subjectKind: "prop",
          keys: Object.keys(kv),
          kv,
        });
        return;
      }

      const pose = this._resolvePropPose(scene, state, kv, token.lineNumber);
      const verb = wantShow ? "show" : hasPoseChange ? "move" : "prop";
      if (!state.current) {
        this._openPropSegment(scene, state, pose, token.lineNumber);
        this._emitLane({
          lane: "action",
          token,
          startFrame: scene.cursorFrames,
          endFrame: scene.cursorFrames,
          label: `${scriptName} ${verb}`,
          subject: state.propId,
          subjectKind: "prop",
          keys: Object.keys(kv),
          kv,
        });
        return;
      }
      if (hasPoseChange || wantShow) {
        this._applyPropPose(scene, state, pose, token.lineNumber);
      }
      this._emitLane({
        lane: "action",
        token,
        startFrame: scene.cursorFrames,
        endFrame: scene.cursorFrames,
        label: `${scriptName} ${verb}`,
        subject: state.propId,
        subjectKind: "prop",
        keys: Object.keys(kv),
        kv,
      });
    });
  }

  _handleLayer(token) {
    const scene = this._requireScene(token.lineNumber, "Layer");
    const { character: scriptName, kv, note } = parseActionTag(token.body);
    if (!scriptName) throw new ScriptError(token.lineNumber, "[Layer: ...] needs a character or prop name.");
    this._warnNoteLooksLikeAssignments(token.lineNumber, "Layer", note);
    if (kv.z === undefined) {
      throw new ScriptError(token.lineNumber, `[Layer: ...] needs z=<integer>.`);
    }
    const extraKeys = Object.keys(kv).filter((key) => key !== "z" && !TIMING_KEYS.has(key) && !HOLD_KEYS.has(key));
    if (extraKeys.length > 0) {
      throw new ScriptError(
        token.lineNumber,
        `[Layer: ...] only accepts z= and optional at_time=/start=/hold=/over=; use [Action: ...] or [Prop: ...] to move. Unexpected: ${extraKeys.join(", ")}`
      );
    }
    const newZ = parseInt(kv.z, 10);
    if (!Number.isFinite(newZ)) {
      throw new ScriptError(token.lineNumber, `Invalid z "${kv.z}" -- expected an integer.`);
    }

    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    const characterId = this.characterLibrary.resolveIdByScriptName(scriptName);
    if (characterId) {
      if (!scene.castOrder.includes(characterId)) {
        scene.castOrder.push(characterId);
      }
      const state = this._ensureCharacterPositioned(scene, characterId, token.lineNumber);
      this._runAtEventTime(scene, eventStart, () => {
        this._applyCharacterZ(scene, state, newZ, token.lineNumber);
        this._emitLane({
          lane: "action",
          token,
          startFrame: scene.cursorFrames,
          endFrame: scene.cursorFrames,
          label: `${scriptName} z=${newZ}`,
          subject: characterId,
          subjectKind: "character",
          keys: ["z"],
          kv,
        });
      });
      return;
    }
    const propState = this._findPropState(scene, scriptName);
    if (!propState) {
      throw new ScriptError(
        token.lineNumber,
        `Unknown character or prop "${scriptName}". Known characters: ${this.characterLibrary.knownNamesSummary()}. Known props: ${this._knownPropNames(scene).join(", ") || "(none)"}`
      );
    }
    if (!propState.current) {
      throw new ScriptError(
        token.lineNumber,
        `"${scriptName}" is hidden -- show it with [Prop: ${scriptName} show] before changing its layer.`
      );
    }
    this._runAtEventTime(scene, eventStart, () => {
      this._applyPropPose(scene, propState, this._resolvePropPose(scene, propState, { z: String(newZ) }, token.lineNumber), token.lineNumber);
      this._emitLane({
        lane: "action",
        token,
        startFrame: scene.cursorFrames,
        endFrame: scene.cursorFrames,
        label: `${scriptName} z=${newZ}`,
        subject: propState.propId,
        subjectKind: "prop",
        keys: ["z"],
        kv,
      });
    });
  }

  _handleActionOnProp(scene, state, kv, note, lineNumber) {
    this._warnNoteLooksLikeAssignments(lineNumber, "Action", note);
    const allowed = new Set(["at", "scale", "z", "drawing", "at_time", "start", "over"]);
    const extra = Object.keys(kv).filter((key) => !allowed.has(key));
    if (extra.length > 0) {
      throw new ScriptError(
        lineNumber,
        `Prop "${state.propId}" has no slots. Unexpected: ${extra.join(", ")}. Use [Prop: ...] or [Layer: ... z=].`
      );
    }
    if (kv.at === undefined && kv.scale === undefined && kv.z === undefined) {
      return;
    }
    const pose = this._resolvePropPose(scene, state, kv, lineNumber);
    if (!state.current) {
      this._openPropSegment(scene, state, pose, lineNumber);
      return;
    }
    this._applyPropPose(scene, state, pose, lineNumber);
  }

  _applyCharacterZ(scene, state, newZ, lineNumber) {
    const current = state.current;
    if (!current) return;
    if (current.z === newZ) return;
    if (current.startFrame === scene.cursorFrames) {
      current.z = newZ;
      current._lineNumber = lineNumber;
      return;
    }
    const transform = { ...current.transform };
    const markName = current.markName;
    this._closeCurrentSegment(state, scene.cursorFrames);
    this._openSegment(scene, state, { transform, z: newZ, markName }, lineNumber);
    this._carryActiveSlots(state, scene, new Set());
    this._carryHeldRig(state, scene);
  }

  // ---- [Action: ...] -------------------------------------------------------

  _handleAction(token) {
    const scene = this._requireScene(token.lineNumber, "Action");
    const { character: scriptName, kv, note } = parseActionTag(token.body);
    if (!scriptName) throw new ScriptError(token.lineNumber, "[Action: ...] needs a character name.");
    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    if (!this.characterLibrary.resolveIdByScriptName(scriptName)) {
      const propState = this._findPropState(scene, scriptName);
      if (propState) {
        this._runAtEventTime(scene, eventStart, () => {
          this._handleActionOnProp(scene, propState, kv, note, token.lineNumber);
          this._emitLane({
            lane: "action",
            token,
            startFrame: scene.cursorFrames,
            endFrame: scene.cursorFrames,
            label: `${scriptName} ${note || Object.keys(kv).join(" ") || "action"}`.trim(),
            subject: propState.propId,
            subjectKind: "prop",
            keys: Object.keys(kv),
            kv,
          });
        });
        return;
      }
    }
    const characterId = this._resolveCharacterIdOrThrow(scriptName, token.lineNumber);

    if (!scene.castOrder.includes(characterId)) {
      scene.castOrder.push(characterId);
    }
    const state = this._ensureCharacterPositioned(scene, characterId, token.lineNumber);
    this._warnNoteLooksLikeAssignments(token.lineNumber, "Action", note);

    const positionKeys = ["at", "scale", "flip", "z"];
    const hasPositionChange = positionKeys.some((k) => kv[k] !== undefined);

    this._runAtEventTime(scene, eventStart, () => {
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
          this._carryHeldRig(state, scene);
        }
      }
    }

    if (kv.view !== undefined) {
      const view = parseViewValue(kv.view, token.lineNumber);
      state.currentView = view || "front";
      const startRel = Math.max(0, scene.cursorFrames - state.current.startFrame);
      this._addViewKeyframe(state.current, { frame: startRel, view: state.currentView });
    }

    for (const [key, value] of Object.entries(kv)) {
      if (
        positionKeys.includes(key) ||
        TIMING_KEYS.has(key) ||
        HOLD_KEYS.has(key) ||
        TRIM_KEYS.has(key) ||
        key === "view"
      ) {
        continue;
      }
      this._applySlotKeyframe(scene, state, characterId, key, value, token.lineNumber);
    }

    const bits = [];
    if (kv.at) bits.push(`at=${kv.at}`);
    if (kv.z) bits.push(`z=${kv.z}`);
    if (kv.scale) bits.push(`scale=${kv.scale}`);
    if (kv.flip) bits.push("flip");
    if (kv.view) bits.push(`view=${kv.view}`);
    for (const [key, value] of Object.entries(kv)) {
      if (
        positionKeys.includes(key) ||
        TIMING_KEYS.has(key) ||
        HOLD_KEYS.has(key) ||
        TRIM_KEYS.has(key) ||
        key === "view"
      ) {
        continue;
      }
      bits.push(`${key}=${value}`);
    }
    if (kv.hold) bits.push(`hold=${kv.hold}`);
    else if (kv.over) bits.push(`over=${kv.over}`);
    if (note) bits.push(note);
    this._emitLane({
      lane: "action",
      token,
      startFrame: scene.cursorFrames,
      endFrame: scene.cursorFrames,
      label: `${scriptName}${bits.length ? " " + bits.join(" ") : ""}`,
      subject: characterId,
      subjectKind: "character",
      keys: Object.keys(kv),
      kv,
    });
    });
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

    const drawings = actionLibrary.slotDrawingNames(
      this.projectDir,
      this.globalAssetsDir,
      characterId,
      slotName,
      owner.slotConfig
    );
    const cycles = (owner.slotConfig && owner.slotConfig.cycles) || {};
    const drawingName = String(drawing == null ? "" : drawing).trim();
    const namedCycle = cycles[drawingName];
    const displayName = config.display_name || characterId;
    const available = [...drawings].join(", ") || "(none)";

    let keyframe;
    const segment = state.current;
    const relativeFrame = scene.cursorFrames - segment.startFrame;

    if (!drawingName) {
      throw new ScriptError(
        lineNumber,
        `${displayName} ${slotName} is missing a drawing. Use a drawing name, or none to hide the slot. Available: ${available}`
      );
    }
    if (drawingName.toLowerCase() === HIDE_DRAWING) {
      keyframe = { frame: relativeFrame, drawing: HIDE_DRAWING };
      this._writeSlotKeyframe(segment, owner, slotName, keyframe);
      state.activeSlots.set(slotStateKey(owner, slotName), {
        ownerType: owner.ownerType,
        childId: owner.childId,
        slotName,
        drawing: "none",
        startedAtSceneFrame: undefined,
      });
      return;
    }

    if (namedCycle) {
      const cycleDrawings = namedCycle.drawings || [];
      if (cycleDrawings.length === 0) {
        throw new ScriptError(lineNumber, `${displayName} cycle "${drawingName}" on ${slotName} has no drawings.`);
      }
      const missing = cycleDrawings.filter((d) => !drawings.has(d));
      if (missing.length > 0) {
        throw new ScriptError(
          lineNumber,
          `${displayName} cycle "${drawingName}" on ${slotName} references missing drawing(s) ${missing.join(", ")}. Available: ${available}`
        );
      }
      const cycleFps = namedCycle.fps;
      if (!Number.isFinite(cycleFps) || cycleFps <= 0) {
        throw new ScriptError(lineNumber, `${displayName} cycle "${drawingName}" on ${slotName} has an invalid fps.`);
      }
      keyframe = { frame: relativeFrame, cycle: [...cycleDrawings], fps: cycleFps };
    } else if (drawings.has(drawingName)) {
      keyframe = { frame: relativeFrame, drawing: drawingName };
    } else {
      const cycleNames = Object.keys(cycles);
      if (cycleNames.length > 0) {
        throw new ScriptError(
          lineNumber,
          `${displayName} has no ${slotName} drawing or cycle "${drawingName}". Available drawings: ${available}. Available cycles: ${cycleNames.join(", ")}`
        );
      }
      throw new ScriptError(
        lineNumber,
        `${displayName} has no ${slotName} drawing "${drawingName}". Available: ${available}`
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

  /**
   * Write opening joint / group / body-lean samples onto a newly forked
   * layer so a held [Do:] pose survives [Action: at=/flip=/z=].
   */
  _carryHeldRig(state, scene) {
    if (!state.current) return;
    const rel = Math.max(0, scene.cursorFrames - state.current.startFrame);
    for (const [childId, rotation] of state.childRotations) {
      const child = this._findChild(state.config, childId);
      const rest = child && child.rotation !== undefined ? child.rotation : 0;
      if (rotation === rest) continue;
      this._addRotationKeyframe(state.current, childId, { frame: rel, rotation, ease: "linear" });
    }
    for (const [groupName, rotation] of state.groupRotations) {
      if (!rotation) continue;
      this._addGroupRotationKeyframe(state.current, groupName, { frame: rel, rotation, ease: "linear" });
    }
    if (state.bodyRotation) {
      const live = state.current;
      live.transform = { ...live.transform, rotation: state.bodyRotation };
      if (rel === 0) {
        live.openingTransform = { ...live.openingTransform, rotation: state.bodyRotation };
      } else {
        this._addTransformKeyframe(live, { frame: rel, rotation: state.bodyRotation, ease: "linear" });
      }
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

  _addViewKeyframe(segment, keyframe) {
    if (!segment.viewKeyframes) segment.viewKeyframes = [];
    const existing = segment.viewKeyframes.find((k) => k.frame === keyframe.frame);
    if (existing) {
      existing.view = keyframe.view;
      return;
    }
    segment.viewKeyframes.push({ frame: keyframe.frame, view: keyframe.view });
  }

  _previousView(state) {
    const clips = (state.current && state.current.dialogue) || [];
    for (let i = clips.length - 1; i >= 0; i--) {
      if (clips[i].view) return clips[i].view;
    }
    return state.currentView || "front";
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

  _addGroupRotationKeyframe(segment, groupName, keyframe) {
    if (!segment.groupRotationKeyframes) segment.groupRotationKeyframes = new Map();
    let list = segment.groupRotationKeyframes.get(groupName);
    if (!list) {
      list = [];
      segment.groupRotationKeyframes.set(groupName, list);
    }
    const existing = list.find((k) => k.frame === keyframe.frame);
    if (existing) {
      Object.assign(existing, keyframe);
      return;
    }
    list.push(keyframe);
  }

  _findGroupName(config, name) {
    const groups = this._characterGroups(config);
    if (!groups) return null;
    if (groups[name]) return name;
    const lower = String(name).toLowerCase();
    return Object.keys(groups).find((g) => g.toLowerCase() === lower) || null;
  }

  _availableGroups(config) {
    const groups = this._characterGroups(config);
    return groups ? Object.keys(groups) : [];
  }

  _getGroupRotation(state, groupName) {
    if (state.groupRotations.has(groupName)) return state.groupRotations.get(groupName);
    state.groupRotations.set(groupName, 0);
    return 0;
  }

  _addCameraKeyframe(scene, keyframe) {
    const existing = scene.cameraKeyframes.find((k) => k.frame === keyframe.frame);
    if (existing) {
      Object.assign(existing, keyframe);
      return;
    }
    scene.cameraKeyframes.push(keyframe);
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
    const availableParts = this._availableParts(state.config);
    const availableGroups = this._availableGroups(state.config);
    const availableHint = () => {
      const bits = [`Available: ${availableParts.join(", ") || "(none)"}`];
      if (availableGroups.length) bits.push(`Groups: ${availableGroups.join(", ")}`);
      return bits.join(". ");
    };
    for (const [key, value] of Object.entries(kv)) {
      if (reservedKeys.has(key)) continue;
      const groupName = this._findGroupName(state.config, key);
      if (groupName) {
        const degrees = parseNumberValue(value, lineNumber, `${tagName} ${key}`);
        parts.push({ kind: "group", id: groupName, degrees });
        continue;
      }
      const child = this._findChild(state.config, key);
      if (!child) {
        throw new ScriptError(
          lineNumber,
          `Unknown part "${key}" on ${state.config.display_name || state.characterId}. ${availableHint()}`
        );
      }
      const degrees = parseNumberValue(value, lineNumber, `${tagName} ${key}`);
      parts.push({ kind: "child", id: child.id, degrees });
    }
    if (parts.length === 0) {
      throw new ScriptError(
        lineNumber,
        `[${tagName}: ...] needs at least one part or group angle (e.g. right_arm=30 or head=8). ${availableHint()}`
      );
    }
    return parts;
  }

  _applyMotionKeys(segment, state, parts, makeKeys) {
    for (const part of parts) {
      if (part.kind === "group") {
        const current = this._getGroupRotation(state, part.id);
        const keys = makeKeys(current, part.degrees);
        for (const key of keys) this._addGroupRotationKeyframe(segment, part.id, key);
        state.groupRotations.set(part.id, keys.length ? keys[keys.length - 1].rotation : current);
      } else {
        const current = this._getChildRotation(state, part.id);
        const keys = makeKeys(current, part.degrees);
        for (const key of keys) this._addRotationKeyframe(segment, part.id, key);
        state.childRotations.set(part.id, keys.length ? keys[keys.length - 1].rotation : current);
      }
    }
  }

  _applyCharacterFlipX(scene, state, flipX, lineNumber) {
    const current = state.current;
    if (!current) return;
    if (!!current.transform.flip_x === !!flipX) return;
    const newTransform = { ...current.transform, flip_x: !!flipX };
    const sameFrameAsSegmentStart = current.startFrame === scene.cursorFrames;
    if (sameFrameAsSegmentStart) {
      current.transform = { ...current.transform, flip_x: newTransform.flip_x };
      current.openingTransform = { ...current.openingTransform, flip_x: newTransform.flip_x };
      current._lineNumber = lineNumber;
      return;
    }
    const markName = current.markName;
    const z = current.z;
    this._closeCurrentSegment(state, scene.cursorFrames);
    this._openSegment(scene, state, { markName, transform: newTransform, z }, lineNumber);
    this._carryActiveSlots(state, scene, new Set());
    this._carryHeldRig(state, scene);
  }

  _ensureFacingTravel(scene, state, dx, faces, lineNumber) {
    if (!dx) return;
    const flipX = !!state.current.transform.flip_x;
    const facesRight = String(faces || "right").toLowerCase() !== "left";
    const facingRight = facesRight ? !flipX : flipX;
    const travelingRight = dx > 0;
    if (facingRight === travelingRight) return;
    this._applyCharacterFlipX(scene, state, !flipX, lineNumber);
  }

  _collectActionSlotRestores(state, action) {
    const names = new Set([
      ...Object.keys((action && action.set_slots) || {}),
      ...Object.keys((action && action.slot_frames) || {}),
    ]);
    const restores = [];
    for (const slotName of names) {
      const owner = this._findSlotOwner(state.config, slotName);
      if (!owner) continue;
      restores.push({
        owner,
        slotName,
        prev: this._snapshotActiveSlot(state, owner, slotName),
      });
    }
    return restores;
  }

  _emitActionSlotFrame(state, action, index, relFrame, lastWritten) {
    const slotFrames = action && action.slot_frames;
    if (!slotFrames || typeof slotFrames !== "object") return;
    for (const [slotName, drawings] of Object.entries(slotFrames)) {
      if (!Array.isArray(drawings) || index < 0 || index >= drawings.length) continue;
      const drawing = String(drawings[index] == null ? "" : drawings[index]).trim();
      if (!drawing || lastWritten.get(slotName) === drawing) continue;
      lastWritten.set(slotName, drawing);
      this._writeActionSlotDrawing(state, slotName, drawing, relFrame);
    }
  }

  _writeActionSlotDrawing(state, slotName, drawing, relFrame) {
    const owner = this._findSlotOwner(state.config, slotName);
    if (!owner) return;
    const name = String(drawing == null ? "" : drawing).trim() || HIDE_DRAWING;
    this._writeSlotKeyframe(state.current, owner, slotName, { frame: relFrame, drawing: name });
    state.activeSlots.set(slotStateKey(owner, slotName), {
      ownerType: owner.ownerType,
      childId: owner.childId,
      slotName,
      drawing: name,
      startedAtSceneFrame: undefined,
    });
  }

  _snapshotActiveSlot(state, owner, slotName) {
    const active = state.activeSlots.get(slotStateKey(owner, slotName));
    if (active) {
      return {
        drawing: active.drawing,
        cycle: active.cycle ? [...active.cycle] : undefined,
        fps: active.fps,
      };
    }
    const slotConfig = owner && owner.slotConfig;
    if (slotConfig && slotConfig.default_drawing) {
      return { drawing: slotConfig.default_drawing };
    }
    return null;
  }

  _restoreActiveSlot(state, owner, slotName, prev, scene, endRel) {
    if (!prev) return;
    const keyframe = prev.cycle
      ? { frame: endRel, cycle: [...prev.cycle], fps: prev.fps }
      : { frame: endRel, drawing: prev.drawing };
    this._writeSlotKeyframe(state.current, owner, slotName, keyframe);
    state.activeSlots.set(slotStateKey(owner, slotName), {
      ownerType: owner.ownerType,
      childId: owner.childId,
      slotName,
      drawing: prev.drawing,
      cycle: prev.cycle ? [...prev.cycle] : undefined,
      fps: prev.fps,
      startedAtSceneFrame: prev.cycle ? scene.cursorFrames : undefined,
    });
  }

  _emitActionWalk(scene, state, action, from, toX, toY, toScale, startRel, endRel, durationFrames, ease) {
    const dx = toX - from.x;
    const dpc = action.distance_per_cycle;
    const naturalPxPerSec = dpc > 0 ? dpc * (from.scale || 1) * action.fps / action.frames : 0;
    const naturalSeconds = naturalPxPerSec > 0 ? Math.abs(dx) / naturalPxPerSec : 0;
    const durationSeconds = durationFrames / this.fps;
    // Standing still (dx=0) used to make cycleFps=0, so bob/joints stuck on frame 0.
    const cycleFps =
      durationSeconds > 0 && naturalSeconds > 0
        ? action.fps * (naturalSeconds / durationSeconds)
        : action.fps;
    const lastSlotDrawing = new Map();

    for (let f = 0; f <= durationFrames; f++) {
      const t = durationFrames === 0 ? 1 : f / durationFrames;
      const x = from.x + (toX - from.x) * t;
      const y = from.y + (toY - from.y) * t;
      const scale = from.scale + (toScale - from.scale) * t;
      const elapsedSec = f / this.fps;
      const phase = elapsedSec * cycleFps;
      let index = action.frames > 0 ? Math.floor(phase) % action.frames : 0;
      if (index < 0) index += action.frames;
      const bob = action.bob && f < durationFrames ? Number(action.bob[index]) || 0 : 0;
      const key = {
        frame: startRel + f,
        x,
        y: y + bob * scale,
        scale,
      };
      if (ease && ease !== "linear") key.ease = ease;
      else if (f < durationFrames) key.ease = "linear";
      this._addTransformKeyframe(state.current, key);

      for (const [jointId, angles] of Object.entries(action.joints || {})) {
        const rotation = f === durationFrames ? 0 : Number(angles[index]);
        this._addRotationKeyframe(state.current, jointId, {
          frame: startRel + f,
          rotation,
          ease: "linear",
        });
      }

      if (f < durationFrames) {
        this._emitActionSlotFrame(state, action, index, startRel + f, lastSlotDrawing);
      }
    }

    for (const jointId of Object.keys(action.joints || {})) {
      state.childRotations.set(jointId, 0);
    }
  }

  _actionCycleIndex(action, frameOffset) {
    const elapsedSec = frameOffset / this.fps;
    const phase = elapsedSec * action.fps;
    let index = action.frames > 0 ? Math.floor(phase) % action.frames : 0;
    if (index < 0) index += action.frames;
    return index;
  }

  // ---- [Move: ...] -------------------------------------------------------

  _handleMove(token) {
    const { scene, state, kv } = this._requireCharacterForMotion(token, "Move");
    if (kv.to === undefined) {
      throw new ScriptError(token.lineNumber, `[Move: ...] needs to=<mark> or to=<x,y>.`);
    }

    const actionId = kv.action;
    let action = null;
    if (actionId !== undefined && String(actionId).trim() !== "") {
      action = actionLibrary.loadAndValidateAction(
        this.projectDir,
        this.globalAssetsDir,
        state.characterId,
        String(actionId).trim(),
        { config: state.config, lineNumber: token.lineNumber }
      );
    }

    const ease = parseEaseValue(kv.ease, token.lineNumber);
    if (action && ease === "inout") {
      this.warnings.push(
        `Line ${token.lineNumber}: ease=inout with action=${actionId} will slide the feet. Use linear (the default).`
      );
    }
    const wait = parseWaitValue(kv.wait, token.lineNumber);

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

    let durationSeconds;
    if (kv.over !== undefined) {
      durationSeconds = parseSecondsSpec(kv.over, token.lineNumber, "over");
    } else if (action) {
      const dpc = action.distance_per_cycle;
      if (!(dpc > 0)) {
        throw new ScriptError(
          token.lineNumber,
          `Action "${actionId}" needs distance_per_cycle to travel. Use [Do: ${state.config.display_name || state.characterId} ${actionId}] to play it in place.`
        );
      }
      const scale = from.scale || 1;
      const pxPerSec = (dpc * scale * action.fps) / action.frames;
      const dx = Math.abs(toX - from.x);
      if (!(pxPerSec > 0)) {
        throw new ScriptError(token.lineNumber, `Action "${actionId}" distance_per_cycle produces no travel speed.`);
      }
      durationSeconds = dx / pxPerSec;
    } else {
      durationSeconds = parseSecondsSpec(kv.over, token.lineNumber, "over");
    }
    const durationFrames = framesFromSeconds(durationSeconds, this.fps);
    if (durationFrames <= 0) {
      throw new ScriptError(
        token.lineNumber,
        action && kv.over === undefined
          ? `Move action="${actionId}" duration rounds to 0 frames at ${this.fps} fps.`
          : `Invalid over "${kv.over}" -- duration rounds to 0 frames at ${this.fps} fps.`
      );
    }

    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    this._runAtEventTime(scene, eventStart, () => {
      const prevView = this._previousView(state);
      if (action) {
        this._ensureFacingTravel(scene, state, toX - state.current.transform.x, action.faces, token.lineNumber);
      }

      const live = state.current;
      const liveFrom = live.transform;
      const startRel = Math.max(0, scene.cursorFrames - live.startFrame);
      const endRel = startRel + durationFrames;

      if (action && action.view) {
        this._addViewKeyframe(live, { frame: startRel, view: action.view });
        this._addViewKeyframe(live, { frame: endRel, view: prevView || "front" });
      }

      const slotRestores = action ? this._collectActionSlotRestores(state, action) : [];
      if (action && action.set_slots) {
        for (const [slotName, drawing] of Object.entries(action.set_slots)) {
          this._applySlotKeyframe(scene, state, state.characterId, slotName, drawing, token.lineNumber);
        }
      }

      if (action) {
        this._emitActionWalk(scene, state, action, liveFrom, toX, toY, toScale, startRel, endRel, durationFrames, ease);
        for (const item of slotRestores) {
          this._restoreActiveSlot(state, item.owner, item.slotName, item.prev, scene, endRel);
        }
      } else {
        this._addTransformKeyframe(live, {
          frame: startRel,
          x: liveFrom.x,
          y: liveFrom.y,
          scale: liveFrom.scale,
          ease,
        });
        this._addTransformKeyframe(live, {
          frame: endRel,
          x: toX,
          y: toY,
          scale: toScale,
        });
      }

      live.transform = { ...liveFrom, x: toX, y: toY, scale: toScale };
      live.markName = markName;
      if (Object.prototype.hasOwnProperty.call(state, "lastPose") || action) {
        state.lastPose = { transform: { ...live.transform }, z: live.z, markName };
      }
      const displayName = (state.config && state.config.display_name) || state.characterId;
      this._emitLane({
        lane: "action",
        token,
        startFrame: eventStart,
        endFrame: eventStart + durationFrames,
        label: action ? `${displayName} walk` : `${state.characterId} → ${kv.to}`,
        subject: state.characterId,
        kv,
        keys: Object.keys(kv),
      });
    });
    this._noteHorizon(scene, eventStart + durationFrames);
    if (wait) scene.cursorFrames += durationFrames;
  }

  // ---- [Pose: ...] -------------------------------------------------------

  _handlePose(token) {
    const { scene, state, kv } = this._requireCharacterForMotion(token, "Pose");
    const reserved = new Set(["over", "ease", "wait", "at_time", "start"]);
    const parts = this._collectPartAngles(kv, reserved, state, token.lineNumber, "Pose");
    const overSeconds = parseSecondsSpec(kv.over, token.lineNumber, "over");
    const ease = parseEaseValue(kv.ease, token.lineNumber);
    const wait = parseWaitValue(kv.wait, token.lineNumber);
    const durationFrames = framesFromSeconds(overSeconds, this.fps);
    if (durationFrames <= 0) {
      throw new ScriptError(token.lineNumber, `Invalid over "${kv.over}" -- duration rounds to 0 frames at ${this.fps} fps.`);
    }

    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    this._runAtEventTime(scene, eventStart, () => {
      const segment = state.current;
      const startRel = Math.max(0, scene.cursorFrames - segment.startFrame);
      const endRel = startRel + durationFrames;

      this._applyMotionKeys(segment, state, parts, (from, degrees) => [
        { frame: startRel, rotation: from, ease },
        { frame: endRel, rotation: degrees },
      ]);

      this._emitLane({
        lane: "action",
        token,
        startFrame: eventStart,
        endFrame: eventStart + durationFrames,
        label: `${state.characterId} pose ${parts.map((p) => p.id).join(" ")}`.trim(),
        subject: state.characterId,
        kv,
        keys: Object.keys(kv),
      });
    });
    this._noteHorizon(scene, eventStart + durationFrames);
    if (wait) scene.cursorFrames += durationFrames;
  }

  // ---- [Swing: ...] ------------------------------------------------------

  _handleSwing(token) {
    const { scene, state, kv } = this._requireCharacterForMotion(token, "Swing");
    const reserved = new Set(["period", "for", "wait", "ease", "at_time", "start"]);
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

    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    this._runAtEventTime(scene, eventStart, () => {
      const segment = state.current;
      const startRel = Math.max(0, scene.cursorFrames - segment.startFrame);

      this._applyMotionKeys(segment, state, parts, (current, amplitude) =>
        swingRotationKeyframes(current, amplitude, periodFrames, durationFrames, startRel)
      );

      this._emitLane({
        lane: "action",
        token,
        startFrame: eventStart,
        endFrame: eventStart + durationFrames,
        label: `${state.characterId} swing`,
        subject: state.characterId,
        kv,
        keys: Object.keys(kv),
      });
    });
    this._noteHorizon(scene, eventStart + durationFrames);
    if (wait) scene.cursorFrames += durationFrames;
  }

  // ---- [Camera: ...] -----------------------------------------------------

  _parseInsertDurationFrames(kv, startFrame, lineNumber) {
    if (kv.to !== undefined) {
      const spec = parseAtTimeSpec(kv.to, lineNumber, "to");
      const last = spec.frames !== undefined ? spec.frames : Math.max(0, Math.round(spec.seconds * this.fps));
      const span = insertDurationFrames(startFrame, last);
      if (span.frames < 1) {
        throw new ScriptError(lineNumber, `[Insert: ...] to=${kv.to} is not after at_time=${startFrame}.`);
      }
      return span;
    }
    const raw = kv.for !== undefined ? kv.for : kv.over;
    const label = kv.for !== undefined ? "for" : "over";
    if (raw === undefined) {
      throw new ScriptError(
        lineNumber,
        `[Insert: ...] needs for=<frames> (or for=1s) or to=<last frame>, e.g. at_time=942 for=11.`
      );
    }
    if (/^\d+$/.test(String(raw))) {
      const frames = parseInt(raw, 10);
      if (frames < 1) throw new ScriptError(lineNumber, `Invalid ${label} "${raw}" -- must be at least 1 frame.`);
      return insertDurationFrames(startFrame, startFrame + frames - 1);
    }
    const seconds = parseSecondsSpec(raw, lineNumber, label);
    const frames = framesFromSeconds(seconds, this.fps);
    if (frames < 1) {
      throw new ScriptError(lineNumber, `Invalid ${label} "${raw}" -- duration rounds to 0 frames at ${this.fps} fps.`);
    }
    return insertDurationFrames(startFrame, startFrame + frames - 1);
  }

  _handleInsert(token) {
    const scene = this._requireScene(token.lineNumber, "Insert");
    const { kv, note } = parseKvTag(token.body);
    this._warnNoteLooksLikeAssignments(token.lineNumber, "Insert", note);
    for (const key of Object.keys(kv)) {
      if (!INSERT_KEYS.has(key)) {
        throw new ScriptError(
          token.lineNumber,
          `Unknown [Insert: ...] argument "${key}". Allowed: image, file, at_time, start, for, over, to, z, x, y, scale, anchor.`
        );
      }
    }
    const image = kv.image || kv.file || kv.src;
    if (!image) {
      throw new ScriptError(token.lineNumber, `[Insert: ...] needs image=<path> to a PNG in this project.`);
    }
    const resolved = assetLibrary.resolveAsset(this.projectDir, this.globalAssetsDir, image);
    if (!resolved) {
      throw new ScriptError(token.lineNumber, `Insert image "${image}" was not found in this project.`);
    }
    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    const span = this._parseInsertDurationFrames(kv, eventStart, token.lineNumber);
    const baseId = `insert_${slugInsertId(path.basename(image, path.extname(image)))}`;
    let id = baseId;
    let n = 2;
    while (scene.inserts.some((item) => item.id === id)) {
      id = `${baseId}_${n++}`;
    }
    const z = kv.z !== undefined ? Math.round(parseNumberValue(kv.z, token.lineNumber, "z")) : 1000;
    const x = kv.x !== undefined ? parseNumberValue(kv.x, token.lineNumber, "x") : scene.canvas.width / 2;
    const y = kv.y !== undefined ? parseNumberValue(kv.y, token.lineNumber, "y") : scene.canvas.height / 2;
    const scale = kv.scale !== undefined ? parseNumberValue(kv.scale, token.lineNumber, "scale") : 1;
    if (!(scale > 0)) throw new ScriptError(token.lineNumber, `Invalid scale "${kv.scale}" -- must be greater than 0.`);
    const anchor = kv.anchor || "center";
    const allowedAnchor = new Set([
      "top-left",
      "top-center",
      "top-right",
      "center-left",
      "center",
      "center-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ]);
    if (!allowedAnchor.has(anchor)) {
      throw new ScriptError(token.lineNumber, `Invalid anchor "${anchor}".`);
    }
    scene.inserts.push({
      id,
      asset: resolved.timelinePath,
      startFrame: span.startFrame,
      endFrame: span.endFrame,
      z,
      transform: { x, y, scale, anchor, flip_x: false },
      lineNumber: token.lineNumber,
    });
    this._noteHorizon(scene, span.endFrame);
    this._emitLane({
      lane: "inserts",
      token,
      startFrame: span.startFrame,
      endFrame: span.endFrame,
      label: `insert ${path.basename(image, path.extname(image))}`,
      subject: id,
      rel: resolved.timelinePath,
      keys: Object.keys(kv),
      kv,
    });
  }

  _handleCamera(token) {
    const scene = this._requireScene(token.lineNumber, "Camera");
    const { kv, note } = parseKvTag(token.body, { bareFlags: ["reset"] });
    this._warnNoteLooksLikeAssignments(token.lineNumber, "Camera", note);

    for (const key of Object.keys(kv)) {
      if (!CAMERA_KEYS.has(key)) {
        throw new ScriptError(
          token.lineNumber,
          `Unknown [Camera: ...] argument "${key}". Allowed: zoom, pan, tilt, to, over, ease, wait, reset, at_time, start.`
        );
      }
    }

    const isReset = kv.reset === "true";
    const hasZoom = kv.zoom !== undefined;
    const hasPan = kv.pan !== undefined;
    const hasTilt = kv.tilt !== undefined;
    const hasTo = kv.to !== undefined;

    if (isReset && (hasZoom || hasPan || hasTilt || hasTo)) {
      throw new ScriptError(
        token.lineNumber,
        `[Camera: reset] cannot combine with zoom, pan, tilt, or to.`
      );
    }
    if (!isReset && !hasZoom && !hasPan && !hasTilt && !hasTo) {
      throw new ScriptError(
        token.lineNumber,
        `[Camera: ...] needs zoom=, pan=, tilt=, to=, or reset.`
      );
    }
    if (hasTo && hasPan) {
      throw new ScriptError(token.lineNumber, `[Camera: ...] cannot combine to= and pan=.`);
    }
    if (hasTo && hasTilt) {
      throw new ScriptError(
        token.lineNumber,
        `[Camera: ...] cannot combine to= and tilt= (tilt is a vertical shift from the current centre).`
      );
    }

    const overSeconds = parseSecondsSpec(kv.over, token.lineNumber, "over");
    const ease = parseEaseValue(kv.ease, token.lineNumber);
    const wait = parseWaitValue(kv.wait, token.lineNumber);
    const durationFrames = framesFromSeconds(overSeconds, this.fps);
    if (durationFrames <= 0) {
      throw new ScriptError(token.lineNumber, `Invalid over "${kv.over}" -- duration rounds to 0 frames at ${this.fps} fps.`);
    }

    const from = scene.camera;
    let toX = from.x;
    let toY = from.y;
    let toZoom = from.zoom;

    if (isReset) {
      toX = scene.canvas.width / 2;
      toY = scene.canvas.height / 2;
      toZoom = 1.0;
    } else {
      if (hasTo) {
        const xy = parseXyPair(kv.to);
        if (!xy) {
          throw new ScriptError(
            token.lineNumber,
            `Invalid to "${kv.to}" -- expected canvas coordinates like "960,540" (no spaces).`
          );
        }
        toX = xy.x;
        toY = xy.y;
      }
      if (hasPan) {
        const xy = parseXyPair(kv.pan);
        if (!xy) {
          throw new ScriptError(
            token.lineNumber,
            `Invalid pan "${kv.pan}" -- expected canvas coordinates like "960,540" (no spaces).`
          );
        }
        toX = xy.x;
        toY = xy.y;
      }
      if (hasTilt) {
        toY = from.y + parseNumberValue(kv.tilt, token.lineNumber, "tilt");
      }
      if (hasZoom) {
        toZoom = parseNumberValue(kv.zoom, token.lineNumber, "zoom");
        if (toZoom <= 0) {
          throw new ScriptError(token.lineNumber, `Invalid zoom "${kv.zoom}" -- must be greater than 0.`);
        }
      }
    }

    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    const endFrame = eventStart + durationFrames;
    const startKey = { frame: eventStart, x: from.x, y: from.y, zoom: from.zoom };
    if (ease !== "linear") startKey.ease = ease;
    this._addCameraKeyframe(scene, startKey);
    this._addCameraKeyframe(scene, { frame: endFrame, x: toX, y: toY, zoom: toZoom });

    scene.camera = { x: toX, y: toY, zoom: toZoom };
    this._noteHorizon(scene, endFrame);
    if (wait) scene.cursorFrames += durationFrames;
    const cameraBits = [];
    if (isReset) cameraBits.push("reset");
    if (hasZoom) cameraBits.push(`zoom=${kv.zoom}`);
    if (hasPan) cameraBits.push(`pan=${kv.pan}`);
    if (hasTilt) cameraBits.push(`tilt=${kv.tilt}`);
    if (hasTo) cameraBits.push(`to=${kv.to}`);
    this._emitLane({
      lane: "camera",
      token,
      startFrame: eventStart,
      endFrame,
      label: cameraBits.join(" ") || "camera",
      kv,
      keys: Object.keys(kv),
    });
  }

  // ---- [Pause: ...] ----------------------------------------------------

  _handlePause(token) {
    const scene = this._requireScene(token.lineNumber, "Pause");
    const { frames, seconds } = parsePauseValue(token.body, token.lineNumber);
    const advance = frames !== undefined ? frames : framesFromSeconds(seconds, this.fps);
    scene.cursorFrames += advance;
  }

  // ---- [Do: Name <actionId> for=Ns wait=] -------------------------------

  _handleDo(token) {
    const scene = this._requireScene(token.lineNumber, "Do");
    const { character: scriptName, kv, note, positional } = parseActionTag(token.body, { allowPositional: true });
    this._warnNoteLooksLikeAssignments(token.lineNumber, "Do", note);
    if (!scriptName) throw new ScriptError(token.lineNumber, "[Do: ...] needs a character name.");
    const extra = Object.keys(kv).filter((key) => !DO_KEYS.has(key));
    if (extra.length > 0) {
      throw new ScriptError(
        token.lineNumber,
        `[Do: ...] unknown key "${extra[0]}". Expected an action id, optional for=, wait=, prop=, at_time=/start=.`
      );
    }
    const actionId = (kv.action && String(kv.action).trim()) || (positional && positional[0]) || "";
    if (!actionId) {
      throw new ScriptError(
        token.lineNumber,
        `[Do: ...] needs an action id, e.g. [Do: Rodney nod] or [Do: Rodney nod for=1s].`
      );
    }
    const characterId = this._resolveCharacterIdOrThrow(scriptName, token.lineNumber);
    if (!scene.castOrder.includes(characterId)) {
      scene.castOrder.push(characterId);
    }
    const state = this._ensureCharacterPositioned(scene, characterId, token.lineNumber);
    if (String(actionId).toLowerCase() === BUILTIN_REST_ACTION) {
      this._handleDoRest(scene, state, token, kv);
      return;
    }
    const action = actionLibrary.loadAndValidateAction(
      this.projectDir,
      this.globalAssetsDir,
      state.characterId,
      actionId,
      { config: state.config, lineNumber: token.lineNumber }
    );

    const durationSeconds =
      kv.for !== undefined ? parseSecondsSpec(kv.for, token.lineNumber, "for") : action.frames / action.fps;
    const wait = parseWaitValue(kv.wait, token.lineNumber);
    const durationFrames = framesFromSeconds(durationSeconds, this.fps);
    if (durationFrames <= 0) {
      throw new ScriptError(
        token.lineNumber,
        kv.for !== undefined
          ? `Invalid for "${kv.for}" -- duration rounds to 0 frames at ${this.fps} fps.`
          : `Do action="${actionId}" duration rounds to 0 frames at ${this.fps} fps.`
      );
    }

    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    const holdEnd = action.end === "hold";
    this._runAtEventTime(scene, eventStart, () => {
      const live = state.current;
      const from = live.transform;
      const startRel = Math.max(0, scene.cursorFrames - live.startFrame);
      const endRel = startRel + durationFrames;
      const prevView = this._previousView(state);
      const prevBodyRot = state.bodyRotation || 0;
      const boundProp = kv.prop != null ? String(kv.prop).trim() : "";

      for (const jointId of Object.keys(action.joints || {})) this._getChildRotation(state, jointId);
      for (const groupName of Object.keys(action.groups || {})) this._getGroupRotation(state, groupName);
      const prevChildRots = new Map(state.childRotations);
      const prevGroupRots = new Map(state.groupRotations);
      const propRestores = this._collectActionPropRestores(scene, action, boundProp, token.lineNumber);

      const hasViewCycle = Array.isArray(action.views) && action.views.length > 0;
      const heldView = action.view;
      if (hasViewCycle || heldView) {
        let lastWritten = null;
        for (let f = 0; f < durationFrames; f++) {
          const index = this._actionCycleIndex(action, f);
          const v = hasViewCycle ? action.views[index] : heldView;
          if (v && v !== lastWritten) {
            this._addViewKeyframe(live, { frame: startRel + f, view: v });
            lastWritten = v;
          }
        }
        this._addViewKeyframe(live, { frame: endRel, view: prevView || "front" });
      }

      const slotRestores = this._collectActionSlotRestores(state, action);
      if (action.set_slots) {
        for (const [slotName, drawing] of Object.entries(action.set_slots)) {
          this._applySlotKeyframe(scene, state, state.characterId, slotName, drawing, token.lineNumber);
        }
      }

      const scale = from.scale || 1;
      const lastSlotDrawing = new Map();
      const firedPropEvents = new Set();
      const lastJoints = new Map();
      const lastGroups = new Map();
      let lastBodyRot = prevBodyRot;
      for (let f = 0; f <= durationFrames; f++) {
        const index = this._actionCycleIndex(action, f);
        const atEnd = f === durationFrames;
        if (!atEnd) {
          this._emitActionSlotFrame(state, action, index, startRel + f, lastSlotDrawing);
          this._emitActionPropEvents(
            scene,
            action,
            index,
            eventStart + f,
            boundProp,
            firedPropEvents,
            token.lineNumber
          );
        }

        const transformKey = { frame: startRel + f, ease: "linear" };
        let writeTransform = false;
        if (action.bob) {
          const bob = atEnd ? 0 : Number(action.bob[index]) || 0;
          transformKey.y = from.y + bob * scale;
          writeTransform = true;
        }
        if (action.body_rotation) {
          if (!atEnd) {
            lastBodyRot = Number(action.body_rotation[index]) || 0;
            transformKey.rotation = lastBodyRot;
            writeTransform = true;
          } else if (!holdEnd) {
            transformKey.rotation = prevBodyRot;
            writeTransform = true;
            lastBodyRot = prevBodyRot;
          }
        }
        if (writeTransform) this._addTransformKeyframe(live, transformKey);

        for (const [jointId, angles] of Object.entries(action.joints || {})) {
          const prev = prevChildRots.has(jointId) ? prevChildRots.get(jointId) : 0;
          if (!atEnd) {
            const rotation = Number(angles[index]);
            lastJoints.set(jointId, rotation);
            this._addRotationKeyframe(live, jointId, { frame: startRel + f, rotation, ease: "linear" });
            state.childRotations.set(jointId, rotation);
          } else if (!holdEnd) {
            this._addRotationKeyframe(live, jointId, { frame: startRel + f, rotation: prev, ease: "linear" });
            state.childRotations.set(jointId, prev);
          } else if (lastJoints.has(jointId)) {
            state.childRotations.set(jointId, lastJoints.get(jointId));
          }
        }

        for (const [groupName, angles] of Object.entries(action.groups || {})) {
          const prev = prevGroupRots.has(groupName) ? prevGroupRots.get(groupName) : 0;
          if (!atEnd) {
            const rotation = Number(angles[index]);
            lastGroups.set(groupName, rotation);
            this._addGroupRotationKeyframe(live, groupName, { frame: startRel + f, rotation, ease: "linear" });
            state.groupRotations.set(groupName, rotation);
          } else if (!holdEnd) {
            this._addGroupRotationKeyframe(live, groupName, { frame: startRel + f, rotation: prev, ease: "linear" });
            state.groupRotations.set(groupName, prev);
          } else if (lastGroups.has(groupName)) {
            state.groupRotations.set(groupName, lastGroups.get(groupName));
          }
        }
      }

      if (action.body_rotation) {
        state.bodyRotation = lastBodyRot;
        if (lastBodyRot) live.transform = { ...live.transform, rotation: lastBodyRot };
        else if (live.transform.rotation) {
          const next = { ...live.transform };
          delete next.rotation;
          live.transform = next;
        }
      }

      if (!holdEnd) {
        for (const item of slotRestores) {
          this._restoreActiveSlot(state, item.owner, item.slotName, item.prev, scene, endRel);
        }
        const savedCursor = scene.cursorFrames;
        scene.cursorFrames = eventStart + durationFrames;
        this._restoreActionPropSnapshots(scene, propRestores, token.lineNumber);
        scene.cursorFrames = savedCursor;
      }

      const displayName = (state.config && state.config.display_name) || state.characterId;
      this._emitLane({
        lane: "action",
        token,
        startFrame: eventStart,
        endFrame: eventStart + durationFrames,
        label: `${displayName} ${actionId}`,
        subject: state.characterId,
        kv,
        keys: Object.keys(kv),
      });
    });
    this._noteHorizon(scene, eventStart + durationFrames);
    if (wait) scene.cursorFrames += durationFrames;
  }

  _handleDoRest(scene, state, token, kv) {
    const wait = parseWaitValue(kv.wait, token.lineNumber);
    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    this._runAtEventTime(scene, eventStart, () => {
      const live = state.current;
      const rel = Math.max(0, scene.cursorFrames - live.startFrame);
      for (const child of (state.config && state.config.children) || []) {
        const dest = child.rotation !== undefined ? child.rotation : 0;
        this._addRotationKeyframe(live, child.id, { frame: rel, rotation: dest, ease: "linear" });
        state.childRotations.set(child.id, dest);
      }
      for (const groupName of this._availableGroups(state.config)) {
        this._addGroupRotationKeyframe(live, groupName, { frame: rel, rotation: 0, ease: "linear" });
        state.groupRotations.set(groupName, 0);
      }
      if (state.bodyRotation || (live.transform && live.transform.rotation)) {
        this._addTransformKeyframe(live, { frame: rel, rotation: 0, ease: "linear" });
        state.bodyRotation = 0;
        if (live.transform && live.transform.rotation) {
          const next = { ...live.transform };
          delete next.rotation;
          live.transform = next;
        }
      }
      const slotNames = new Set([
        ...Object.keys((state.config && state.config.slots) || {}),
        ...((state.config && state.config.children) || []).flatMap((c) => Object.keys(c.slots || {})),
      ]);
      for (const slotName of slotNames) {
        if (RESERVED_SLOT_NAMES.has(slotName)) continue;
        const owner = this._findSlotOwner(state.config, slotName);
        if (!owner || !owner.slotConfig) continue;
        const dest = owner.slotConfig.default_drawing;
        if (!dest) continue;
        this._writeSlotKeyframe(live, owner, slotName, { frame: rel, drawing: dest });
        state.activeSlots.set(slotStateKey(owner, slotName), {
          ownerType: owner.ownerType,
          childId: owner.childId,
          slotName,
          drawing: dest,
          startedAtSceneFrame: undefined,
        });
      }
      const displayName = (state.config && state.config.display_name) || state.characterId;
      this._emitLane({
        lane: "action",
        token,
        startFrame: eventStart,
        endFrame: eventStart,
        label: `${displayName} rest`,
        subject: state.characterId,
        kv,
        keys: Object.keys(kv),
      });
    });
    if (wait) {
      /* rest is an instant pin */
    }
  }

  _resolveBoundPropName(eventProp, boundProp, scene, lineNumber) {
    const raw = eventProp != null && String(eventProp).trim() !== "" ? String(eventProp).trim() : PROP_PLACEHOLDER;
    const name = raw === PROP_PLACEHOLDER ? String(boundProp || "").trim() : raw;
    if (!name) {
      throw new ScriptError(
        lineNumber,
        `Action prop_events uses {prop} — add prop=<name> on [Do:], or put a literal prop name in the action. Available: ${this._knownPropNames(scene).join(", ") || "(none)"}`
      );
    }
    const state = this._findPropState(scene, name);
    if (!state) {
      throw new ScriptError(
        lineNumber,
        `Unknown prop "${name}". Available: ${this._knownPropNames(scene).join(", ") || "(none)"}`
      );
    }
    return state;
  }

  _collectActionPropRestores(scene, action, boundProp, lineNumber) {
    const events = (action && action.prop_events) || [];
    if (!events.length) return [];
    const seen = new Set();
    const restores = [];
    for (const ev of events) {
      const propState = this._resolveBoundPropName(ev.prop, boundProp, scene, lineNumber);
      if (seen.has(propState.propId)) continue;
      seen.add(propState.propId);
      if (!propState.current && !propState.lastPose) {
        throw new ScriptError(
          lineNumber,
          `"${propState.propId}" is hidden -- show it with [Prop: ${propState.propId} show] before a prop event.`
        );
      }
      restores.push({
        propId: propState.propId,
        drawing: (propState.current && propState.current.drawing) || propState.drawing || "default",
        z: propState.current ? propState.current.z : propState.lastPose.z,
        transform: propState.current
          ? { ...propState.current.transform }
          : { ...propState.lastPose.transform },
        markName: propState.current ? propState.current.markName : propState.lastPose.markName,
      });
    }
    return restores;
  }

  _emitActionPropEvents(scene, action, index, absFrame, boundProp, fired, lineNumber) {
    const events = (action && action.prop_events) || [];
    if (!events.length) return;
    const saved = scene.cursorFrames;
    scene.cursorFrames = absFrame;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.frame !== index) continue;
      const key = `${i}:${ev.frame}`;
      if (fired.has(key)) continue;
      fired.add(key);
      const propState = this._resolveBoundPropName(ev.prop, boundProp, scene, lineNumber);
      const kv = {};
      if (ev.drawing) kv.drawing = ev.drawing;
      if (ev.z != null) kv.z = String(ev.z);
      const pose = this._resolvePropPose(scene, propState, kv, lineNumber);
      this._applyPropPose(scene, propState, pose, lineNumber);
    }
    scene.cursorFrames = saved;
  }

  _restoreActionPropSnapshots(scene, restores, lineNumber) {
    for (const snap of restores || []) {
      const propState = this._findPropState(scene, snap.propId);
      if (!propState) continue;
      this._applyPropPose(
        scene,
        propState,
        {
          transform: { ...snap.transform },
          z: snap.z,
          markName: snap.markName,
          drawing: snap.drawing,
        },
        lineNumber
      );
    }
  }

  // ---- [View: Name view=<head view>] ------------------------------------

  _handleView(token) {
    const scene = this._requireScene(token.lineNumber, "View");
    const { character: scriptName, kv, note, positional } = parseActionTag(token.body, { allowPositional: true });
    if (!scriptName) throw new ScriptError(token.lineNumber, "[View: ...] needs a character name.");
    this._warnNoteLooksLikeAssignments(token.lineNumber, "View", note);
    const viewRaw = kv.view !== undefined ? kv.view : positional && positional[0];
    if (viewRaw === undefined || viewRaw === "") {
      throw new ScriptError(
        token.lineNumber,
        `[View: ...] needs a view, e.g. [View: Name right_34] or view=<${HEAD_VIEWS.join("|")}>.`
      );
    }
    const extra = Object.keys(kv).filter((key) => key !== "view" && !TIMING_KEYS.has(key));
    if (extra.length > 0) {
      throw new ScriptError(
        token.lineNumber,
        `[View: ...] only accepts a view name, view=, and optional at_time=/start=. Unexpected: ${extra.join(", ")}`
      );
    }
    const view = parseViewValue(viewRaw, token.lineNumber);
    const characterId = this._resolveCharacterIdOrThrow(scriptName, token.lineNumber);
    if (!scene.castOrder.includes(characterId)) {
      scene.castOrder.push(characterId);
    }
    const state = this._ensureCharacterPositioned(scene, characterId, token.lineNumber);
    const eventStart = this._eventStartFrame(kv, scene, token.lineNumber);
    this._runAtEventTime(scene, eventStart, () => {
      state.currentView = view || "front";
      const segment = state.current;
      const startRel = Math.max(0, scene.cursorFrames - segment.startFrame);
      this._addViewKeyframe(segment, { frame: startRel, view: state.currentView });
    });
  }

  // ---- [Audio: Name file=<label>] ---------------------------------------

  async _handleImportedAudio(token) {
    const scene = this._requireScene(token.lineNumber, "Audio");
    const { character: scriptName, kv, note } = parseActionTag(token.body);
    if (!scriptName) {
      throw new ScriptError(token.lineNumber, "[Audio: ...] needs a character name, e.g. [Audio: Hicks file=monologue].");
    }
    this._warnNoteLooksLikeAssignments(token.lineNumber, "Audio", note);
    const labelRaw = kv.file;
    if (!labelRaw) {
      throw new ScriptError(
        token.lineNumber,
        `[Audio: ...] needs file=<label> (the --name from import-audio).`
      );
    }
    const extra = Object.keys(kv).filter((key) => !AUDIO_KEYS.has(key));
    if (extra.length > 0) {
      throw new ScriptError(
        token.lineNumber,
        `[Audio: ...] unknown key "${extra[0]}". Expected file=<label>, optional lines=true|false, view=, at_time=/start=, and trim_in=/trim_out=.`
      );
    }
    let emitSentenceLines = true;
    if (kv.lines !== undefined) {
      try {
        emitSentenceLines = parseWaitValue(kv.lines, token.lineNumber);
      } catch {
        throw new ScriptError(token.lineNumber, `Invalid lines "${kv.lines}" -- expected true or false.`);
      }
    }
    const characterId = this._resolveCharacterIdOrThrow(scriptName, token.lineNumber);
    const label = slugify(labelRaw);
    const imported = resolveImportedTrack(this.projectDir, label, characterId);
    if (!imported) {
      throw new ScriptError(
        token.lineNumber,
        `No imported audio "${labelRaw}" for ${scriptName} (looked for audio/${label}/001_${characterId}.wav). ` +
          `Run: node src/cli.js import-audio <project> <file> --character ${characterId} --name ${label}`
      );
    }

    if (!scene.castOrder.includes(characterId)) {
      this.warnings.push(
        `Line ${token.lineNumber}: "${scriptName}" has [Audio: ...] but was not in [Cast: ...] for scene "${scene.displayName}"; added automatically.`
      );
      scene.castOrder.push(characterId);
    }
    const state = this._ensureCharacterPositioned(scene, characterId, token.lineNumber);

    const absAudioPath = path.join(this.projectDir, imported.wav);
    const sourceSeconds = await probeDurationSeconds(absAudioPath);
    const window = this._audioWindow(kv, sourceSeconds, this.fps, token.lineNumber);
    const startFrame = this._eventStartFrame(kv, scene, token.lineNumber);
    const words = this._wordsInWindow(imported.words || [], window.inSec, window.outSec);
    const text = transcriptFromWords(words) || transcriptFromWords(imported.words) || `[Audio: ${label}]`;

    scene.lineCounter += 1;
    const lineView = this._resolveLineView(kv, state, token.lineNumber);
    const clip = {
      audio: imported.wav,
      start_frame: startFrame - state.current.startFrame,
      text,
    };
    if (fs.existsSync(path.join(this.projectDir, imported.cues))) {
      clip.cues = imported.cues;
    }
    if (words && words.length > 0) {
      clip.words = words;
    }
    if (lineView) clip.view = lineView;
    if (window.inSec > 0) clip.trim_in = Math.round(window.inSec * 1000) / 1000;
    if (window.outSec + 1e-6 < sourceSeconds) clip.trim_out = Math.round(window.outSec * 1000) / 1000;
    if (emitSentenceLines) state.current.dialogue.push(clip);

    const mouthCues = this._readMouthCues(imported.cues);
    const marriedId = this._marriedId(token);
    const trim = { inFrames: window.inFrames, outFrames: window.outFrames };
    const sentences =
      emitSentenceLines && words && words.length > 0 ? wordsToSentences(words) : [];
    if (sentences.length > 0) {
      for (const sentence of sentences) {
        if (sentence.end <= window.inSec || sentence.start >= window.outSec) continue;
        if (sentence.start < window.inSec - 1e-6) continue;
        const sentStart = Math.max(sentence.start, window.inSec);
        const sentEnd = Math.min(sentence.end, window.outSec);
        const lineStart = startFrame + framesFromSeconds(sentStart - window.inSec, this.fps);
        const lineEnd = startFrame + framesFromSeconds(sentEnd - window.inSec, this.fps);
        const chipEnd = Math.min(startFrame + window.durationFrames, Math.max(lineEnd, lineStart + 1));
        this._emitLane({
          lane: "dialogue",
          token,
          startFrame: lineStart,
          endFrame: chipEnd,
          label: `${scriptName}: ${sentence.text}`,
          subject: characterId,
          kv,
          sourceStartFrame: startFrame,
          cues: this._sliceMouthCues(mouthCues, sentStart, sentEnd),
          view: lineView,
          marriedId,
          audioRel: imported.wav,
          cuesRel: imported.cues,
          syncText: sentence.text || text,
          trim,
          sourceDurationFrames: window.sourceFrames,
          words,
        });
      }
    } else if (emitSentenceLines) {
      this._emitLane({
        lane: "dialogue",
        token,
        startFrame,
        endFrame: startFrame + window.durationFrames,
        label: `${scriptName}: ${text}`,
        subject: characterId,
        kv,
        sourceStartFrame: startFrame,
        cues: this._sliceMouthCues(mouthCues, window.inSec, window.outSec),
        view: lineView,
        marriedId,
        audioRel: imported.wav,
        cuesRel: imported.cues,
        syncText: text,
        trim,
        sourceDurationFrames: window.sourceFrames,
        words,
      });
    }
    this._emitLane({
      lane: "audio",
      token,
      startFrame,
      endFrame: startFrame + window.durationFrames,
      label: path.basename(imported.wav),
      subject: characterId,
      rel: imported.wav,
      kv,
      sourceStartFrame: startFrame,
      view: lineView,
      marriedId,
      audioRel: imported.wav,
      cuesRel: imported.cues,
      syncText: text,
      trim,
      sourceDurationFrames: window.sourceFrames,
      words,
    });

    this.lines.push({
      scene_id: scene.sceneId,
      line_number: scene.lineCounter,
      character: characterId,
      text,
      audio_path: imported.wav,
      cues_path: imported.cues,
      words_path: imported.wordsPath,
      voice_id: (state.config && state.config.voice_id) || null,
      status: "ok",
      source: "import",
    });

    this._noteHorizon(scene, startFrame + window.durationFrames);
    scene.cursorFrames += window.durationFrames;
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

    let sourceSeconds;
    let status;
    if (fs.existsSync(absAudioPath)) {
      sourceSeconds = await probeDurationSeconds(absAudioPath);
      status = "ok";
    } else {
      sourceSeconds = estimateDurationSeconds(token.text);
      status = "missing";
    }
    const kv = token.kv || {};
    const window = this._audioWindow(kv, sourceSeconds, this.fps, token.lineNumber);
    const startFrame = this._eventStartFrame(kv, scene, token.lineNumber);
    const words = this._wordsInWindow(this._readWords(audioRelPath), window.inSec, window.outSec);
    const spokenText = words.length > 0 ? transcriptFromWords(words) : token.text;

    const lineView = this._resolveLineView(kv, state, token.lineNumber);
    const clip = {
      audio: audioRelPath,
      start_frame: startFrame - state.current.startFrame,
      text: spokenText,
    };
    if (status === "missing") {
      // Marked on the clip itself (not only in lines.json) so a silent
      // preview render can use the estimate without re-reading the manifest.
      clip.estimated = true;
      clip.estimated_duration_seconds = Math.round(window.durationSec * 100) / 100;
    }
    if (lineView) clip.view = lineView;
    if (words.length > 0) clip.words = words;
    if (window.inSec > 0) clip.trim_in = Math.round(window.inSec * 1000) / 1000;
    if (window.outSec + 1e-6 < sourceSeconds) clip.trim_out = Math.round(window.outSec * 1000) / 1000;
    state.current.dialogue.push(clip);

    const mouthCues = this._sliceMouthCues(this._readMouthCues(`${audioRelPath}.rhubarb.json`), window.inSec, window.outSec);
    const marriedId = this._marriedId(token);
    const trim = { inFrames: window.inFrames, outFrames: window.outFrames };
    const spoken = `${token.character}: ${spokenText}`;
    this._emitLane({
      lane: "dialogue",
      token,
      startFrame,
      endFrame: startFrame + window.durationFrames,
      label: spoken,
      subject: characterId,
      kv,
      sourceStartFrame: startFrame,
      cues: mouthCues,
      view: lineView,
      marriedId,
      audioRel: audioRelPath,
      cuesRel: `${audioRelPath}.rhubarb.json`,
      syncText: spokenText,
      trim,
      sourceDurationFrames: window.sourceFrames,
      words,
    });
    this._emitLane({
      lane: "audio",
      token,
      startFrame,
      endFrame: startFrame + window.durationFrames,
      label: path.basename(audioRelPath),
      subject: characterId,
      rel: audioRelPath,
      kv,
      sourceStartFrame: startFrame,
      view: lineView,
      marriedId,
      audioRel: audioRelPath,
      cuesRel: `${audioRelPath}.rhubarb.json`,
      syncText: spokenText,
      trim,
      sourceDurationFrames: window.sourceFrames,
      words,
    });

    this.lines.push({
      scene_id: scene.sceneId,
      line_number: scene.lineCounter,
      character: characterId,
      text: spokenText,
      audio_path: audioRelPath,
      cues_path: `${audioRelPath}.rhubarb.json`,
      voice_id: (state.config && state.config.voice_id) || null,
      status,
      ...(status === "missing" ? { estimated_duration_seconds: Math.round(window.durationSec * 100) / 100 } : {}),
    });

    this._noteHorizon(scene, startFrame + window.durationFrames);
    scene.cursorFrames += window.durationFrames;
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
    this.errors.push(...findMissingPropAssets(this.usedProps, this.projectDir, this.globalAssetsDir));
    this.errors.push(...findRigHeadAssetErrors(this.usedCharacters, this.projectDir, this.globalAssetsDir));
  }

  // ---- scene finalization -------------------------------------------------

  _closeScene() {
    const scene = this.scene;
    if (!scene) return;

    for (const state of scene.characters.values()) {
      this._closeCurrentSegment(state, undefined); // undefined end_frame -> "through end of scene"
    }
    for (const state of scene.props.values()) {
      this._closeCurrentSegment(state, undefined);
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
    for (const state of scene.props.values()) {
      for (const segment of state.segments) {
        layers.push(this._buildPropLayerJson(state, segment));
      }
    }
    for (const insert of scene.inserts) {
      layers.push(this._buildInsertLayerJson(insert));
    }

    const endFrames = Math.max(scene.cursorFrames, scene.horizonFrames);
    const extraHold = Math.max(0, endFrames - scene.cursorFrames);
    const duration =
      anyDialogue
        ? { from_dialogue: true, padding_frames: DEFAULT_SCENE_PADDING_FRAMES + extraHold }
        : { frames: Math.max(endFrames, this.fps) }; // at least 1s for a silent/establishing scene

    const sceneJson = {
      id: scene.sceneId,
      duration,
      background: { asset: scene.background },
      layers,
    };
    if (scene.cameraKeyframes.length > 0) {
      sceneJson.camera = {
        keyframes: [...scene.cameraKeyframes].sort((a, b) => a.frame - b.frame),
      };
    }
    this.scenes.push(sceneJson);

    const sceneFrames = anyDialogue
      ? endFrames + DEFAULT_SCENE_PADDING_FRAMES
      : Math.max(endFrames, this.fps);
    this.sceneLengths.push({ id: scene.sceneId, frames: sceneFrames });

    this.scene = null;
  }

  _buildInsertLayerJson(insert) {
    return {
      id: insert.id,
      insert_id: insert.id,
      asset: insert.asset,
      z: insert.z,
      transform: insert.transform,
      timing: { start_frame: insert.startFrame, end_frame: insert.endFrame },
    };
  }

  _buildPropLayerJson(state, segment) {
    const drawing = segment.drawing || state.drawing || "default";
    const resolved =
      (state.def.resolvedDrawings && state.def.resolvedDrawings[drawing]) ||
      state.def.resolved ||
      assetLibrary.resolveAsset(
        this.projectDir,
        this.globalAssetsDir,
        `backgrounds/${state.def.location}/${(state.def.drawings && state.def.drawings[drawing]) || state.def.asset}`
      );
    if (!resolved) {
      throw new ScriptError(
        segment._lineNumber,
        `Prop "${state.propId}" is missing ${drawing === "default" ? "asset" : `drawing "${drawing}"`} "${state.def.assetRel}".`
      );
    }
    const layer = {
      id: segment.layerId,
      prop_id: state.propId,
      asset: resolved.timelinePath,
      z: segment.z,
      transform: segment.openingTransform || segment.transform,
    };
    if (segment.startFrame !== 0 || segment.endFrame !== undefined) {
      layer.timing = { start_frame: segment.startFrame };
      if (segment.endFrame !== undefined) layer.timing.end_frame = segment.endFrame;
    }
    return layer;
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
    if (segment.viewKeyframes && segment.viewKeyframes.length > 0) {
      layer.view_keyframes = [...segment.viewKeyframes].sort((a, b) => a.frame - b.frame);
    }
    const groupRotMap = segment.closingGroupRotations || state.groupRotations;
    if (groupRotMap && groupRotMap.size) {
      const staticRots = {};
      for (const [name, rot] of groupRotMap) {
        if (rot) staticRots[name] = rot;
      }
      if (Object.keys(staticRots).length) layer.group_rotations = staticRots;
    }
    if (segment.groupRotationKeyframes && segment.groupRotationKeyframes.size) {
      const keyed = {};
      for (const [name, keys] of segment.groupRotationKeyframes) {
        if (keys && keys.length) keyed[name] = [...keys].sort((a, b) => a.frame - b.frame);
      }
      if (Object.keys(keyed).length) layer.group_rotation_keyframes = keyed;
    }
    if (segment.startFrame !== 0 || segment.endFrame !== undefined) {
      layer.timing = { start_frame: segment.startFrame };
      if (segment.endFrame !== undefined) layer.timing.end_frame = segment.endFrame;
    }
    if (segment.dialogue.length > 0) layer.dialogue = segment.dialogue;
    const groups = this._characterGroups(config);
    if (groups) layer.groups = groups;

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

  _characterGroups(config) {
    const raw = config && config.groups;
    if (!raw || typeof raw !== "object") return null;
    const groups = {};
    for (const [name, members] of Object.entries(raw)) {
      if (!Array.isArray(members) || members.length === 0) continue;
      groups[name] = members.map((item) => String(item)).filter(Boolean);
    }
    return Object.keys(groups).length > 0 ? groups : null;
  }

  _headGroupNames(characterId) {
    const config = this.characterLibrary.get(characterId);
    const groups = this._characterGroups(config);
    return groups && Array.isArray(groups.head) ? groups.head : null;
  }

  _applySlotTransform(slot, slotConfig) {
    if (slotConfig.scale != null) slot.scale = slotConfig.scale;
    if (slotConfig.rotation != null) slot.rotation = slotConfig.rotation;
    return slot;
  }

  _applySlotMeta(slot, slotConfig) {
    this._applySlotTransform(slot, slotConfig);
    this._applyDrawingAlign(slot, slotConfig);
    if (slotConfig && slotConfig.z != null && Number.isFinite(Number(slotConfig.z))) {
      slot.z = Number(slotConfig.z);
    }
    const canvas = slotConfig && slotConfig.canvas;
    if (canvas && canvas.w != null && canvas.h != null) {
      const pivot = canvas.pivot || {};
      slot.canvas = {
        w: Number(canvas.w),
        h: Number(canvas.h),
        pivot: { x: Number(pivot.x) || 0, y: Number(pivot.y) || 0 },
      };
    }
    return slot;
  }

  _viewFolderPrefix(drawingsDir, slotName) {
    const dir = String(drawingsDir || slotName || "");
    for (const view of HEAD_VIEWS) {
      const suffix = `_${view}`;
      if (dir.endsWith(suffix)) return dir.slice(0, -suffix.length);
    }
    return dir || slotName;
  }

  _scanViewImages(characterId, slotName, slotConfig) {
    const baseDir = (slotConfig && slotConfig.drawings_dir) || slotName;
    const prefix = this._viewFolderPrefix(baseDir, slotName);
    const images = this._scanSlotImages(characterId, { drawings_dir: baseDir });
    const byView = {};
    const frontAlt = this._scanSlotImages(characterId, { drawings_dir: `${prefix}_front` });
    byView.front = Object.keys(frontAlt).length > 0 ? frontAlt : images;
    for (const view of HEAD_VIEWS) {
      if (view === "front") continue;
      const scanned = this._scanSlotImages(characterId, { drawings_dir: `${prefix}_${view}` });
      if (Object.keys(scanned).length > 0) byView[view] = scanned;
    }
    return { images: byView.front && Object.keys(byView.front).length > 0 ? byView.front : images, images_by_view: byView };
  }

  _scanMouthViewImages(characterId, slotConfig) {
    return this._scanViewImages(characterId, "mouth", slotConfig);
  }

  _excludeFromLipSync(slotConfig) {
    const drawings = slotConfig && slotConfig.drawings;
    if (!drawings || typeof drawings !== "object") return [];
    return Object.entries(drawings)
      .filter(([, meta]) => meta && meta.excludeFromLipSync)
      .map(([name]) => name);
  }

  _drawingAlign(slotConfig) {
    const drawings = slotConfig && slotConfig.drawings;
    if (!drawings || typeof drawings !== "object") return null;
    const align = {};
    for (const [name, meta] of Object.entries(drawings)) {
      const raw = meta && meta.align;
      if (!raw || typeof raw !== "object") continue;
      const x = Number(raw.x);
      const y = Number(raw.y);
      const scale = Number(raw.scale);
      if (![x, y, scale].every(Number.isFinite) || scale <= 0) continue;
      align[name] = { x, y, scale };
    }
    return Object.keys(align).length ? align : null;
  }

  _applyDrawingAlign(slot, slotConfig) {
    const align = this._drawingAlign(slotConfig);
    if (align) slot.align = align;
    return slot;
  }

  _buildSlotJson(characterId, slotName, slotConfig, keyframes) {
    const headGroup = this._headGroupNames(characterId);
    const scanViews =
      slotName === "mouth" ||
      (headGroup && headGroup.includes(slotName)) ||
      Boolean(slotConfig && slotConfig.views === true);
    if (slotName === "mouth") {
      const { images, images_by_view } = this._scanMouthViewImages(characterId, slotConfig);
      const mouth = { offset: slotConfig.offset || { x: 0, y: 0 }, images, images_by_view, lipsync: { source: "dialogue" } };
      if (slotConfig.visible_when) mouth.visible_when = slotConfig.visible_when;
      const excluded = this._excludeFromLipSync(slotConfig);
      if (excluded.length) mouth.exclude_from_lipsync = excluded;
      return this._applySlotMeta(mouth, slotConfig);
    }
    const sorted = keyframes
      .filter((kf) => kf && Number.isFinite(kf.frame) && (usableSlotDrawing(kf.drawing) || (Array.isArray(kf.cycle) && kf.cycle.length && kf.fps)))
      .sort((a, b) => a.frame - b.frame);
    const fallback = usableSlotDrawing(slotConfig && slotConfig.default_drawing);
    if (fallback && (sorted.length === 0 || sorted[0].frame !== 0)) {
      sorted.unshift({ frame: 0, drawing: fallback });
    }
    let images;
    let imagesByView;
    if (scanViews) {
      const scanned = this._scanViewImages(characterId, slotName, slotConfig);
      images = scanned.images;
      imagesByView = scanned.images_by_view;
    } else {
      images = this._scanSlotImages(characterId, slotConfig);
    }
    const slot = { offset: slotConfig.offset || { x: 0, y: 0 }, images, keyframes: sorted };
    if (imagesByView) slot.images_by_view = imagesByView;
    if (slotConfig.visible_when) slot.visible_when = slotConfig.visible_when;
    return this._applySlotMeta(slot, slotConfig);
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
    if (childConfig.visible_when) child.visible_when = childConfig.visible_when;
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
