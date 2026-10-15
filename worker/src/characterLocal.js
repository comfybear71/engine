"use strict";

/**
 * Project-local character.json writes. Studio never edits
 * projects/_global_assets; the first change copies the resolved character
 * into the episode folder (copy-on-write), then later saves patch that file.
 */

const fs = require("fs");
const path = require("path");

const { loadCharacter } = require("./parser/assetLibrary");
const { isSafeFolderName } = require("./studioProjects");

const SLOT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const REFERENCE_DIR = "_reference";

function localError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function characterDir(projectDir, characterId) {
  return path.join(projectDir, "characters", characterId);
}

function posixJoin(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\\/g, "/");
}

function backupIfExists(absPath, backupRoot, relFromRoot) {
  if (!backupRoot || !fs.existsSync(absPath)) return null;
  const dest = path.join(backupRoot, relFromRoot);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(absPath, dest);
  return dest;
}

function readWritableCharacter(projectDir, globalAssetsDir, characterId) {
  const localPath = path.join(characterDir(projectDir, characterId), "character.json");
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, "utf8"));
  }
  const loaded = loadCharacter(projectDir, globalAssetsDir, characterId);
  if (!loaded) throw localError(`Unknown character: ${characterId}`, "ENOTFOUND");
  return JSON.parse(JSON.stringify(loaded));
}

function writeCharacterJson(projectDir, characterId, data, backupRoot) {
  const dir = characterDir(projectDir, characterId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "character.json");
  if (backupRoot) backupIfExists(dest, backupRoot, "character.json");
  fs.writeFileSync(dest, JSON.stringify(data, null, 2) + "\n");
  return dest;
}

function findSlotSpec(character, slotName) {
  if (character.slots && character.slots[slotName]) {
    return character.slots[slotName];
  }
  for (const child of character.children || []) {
    if (child.slots && child.slots[slotName]) return child.slots[slotName];
  }
  return null;
}

function decodeImageBuffer(body) {
  if (!body || typeof body !== "object") {
    throw localError("image is required");
  }
  if (typeof body.imageBase64 === "string" && body.imageBase64) {
    const stripped = body.imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length < 8) throw localError("image is empty");
    return buf;
  }
  throw localError("imageBase64 is required");
}

function imageExtension(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return ".png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  return ".png";
}

function characterReferenceRel(characterId, stored) {
  if (typeof stored !== "string" || !stored.trim()) return null;
  const trimmed = stored.trim().replace(/\\/g, "/");
  if (trimmed.includes("..") || trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("characters/")) return trimmed;
  return posixJoin("characters", characterId, trimmed);
}

function saveCharacterStyle(projectDir, globalAssetsDir, characterId, style) {
  if (!isSafeFolderName(characterId)) throw localError("Invalid character id");
  if (typeof style !== "string") throw localError("style must be a string");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  character.style = style;
  writeCharacterJson(projectDir, characterId, character, null);
  return { ok: true, style: character.style };
}

function saveCharacterReference(projectDir, globalAssetsDir, characterId, body) {
  if (!isSafeFolderName(characterId)) throw localError("Invalid character id");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const image = decodeImageBuffer(body);
  const ext = imageExtension(image);
  const dir = path.join(characterDir(projectDir, characterId), REFERENCE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `full${ext}`;
  const abs = path.join(dir, filename);
  const previous = character.reference;
  fs.writeFileSync(abs, image);
  if (typeof previous === "string" && previous && path.basename(previous) !== filename) {
    const prevRel = characterReferenceRel(characterId, previous);
    if (prevRel && prevRel.startsWith(`characters/${characterId}/${REFERENCE_DIR}/`)) {
      const prevAbs = path.join(projectDir, prevRel);
      if (fs.existsSync(prevAbs) && path.dirname(prevAbs) === dir) {
        fs.unlinkSync(prevAbs);
      }
    }
  }
  character.reference = posixJoin(REFERENCE_DIR, filename);
  writeCharacterJson(projectDir, characterId, character, null);
  return {
    ok: true,
    reference: character.reference,
    referenceRel: posixJoin("characters", characterId, character.reference),
  };
}

function saveSlotAlignment(projectDir, globalAssetsDir, characterId, slotName, body) {
  if (!isSafeFolderName(characterId)) throw localError("Invalid character id");
  if (!SLOT_NAME.test(String(slotName || ""))) throw localError("Invalid slot name");
  const patch = body && typeof body === "object" ? body : {};
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const spec = findSlotSpec(character, slotName);
  if (!spec) throw localError(`Unknown slot: ${slotName}`, "ENOTFOUND");

  if (patch.offset != null) {
    if (typeof patch.offset !== "object" || patch.offset == null) {
      throw localError("offset must be { x, y }");
    }
    const x = Number(patch.offset.x);
    const y = Number(patch.offset.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw localError("offset.x and offset.y must be numbers");
    }
    spec.offset = { x, y };
  }
  if (patch.scale != null) {
    const scale = Number(patch.scale);
    if (!Number.isFinite(scale) || scale <= 0) {
      throw localError("scale must be a number greater than 0");
    }
    spec.scale = scale;
  }
  if (patch.rotation != null) {
    const rotation = Number(patch.rotation);
    if (!Number.isFinite(rotation)) throw localError("rotation must be a number");
    spec.rotation = rotation;
  }

  writeCharacterJson(projectDir, characterId, character, null);
  return {
    ok: true,
    slot: slotName,
    offset: spec.offset || { x: 0, y: 0 },
    scale: spec.scale == null ? 1 : spec.scale,
    rotation: spec.rotation == null ? 0 : spec.rotation,
  };
}

/**
 * Load saved head-rig entries for a character.
 * Returns { rigs: { [key]: { anchorX, anchorY, headScale } } }
 */
function loadHeadRig(projectDir, globalAssetsDir, characterId) {
  if (!isSafeFolderName(characterId)) throw localError("Invalid character id");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const refRel = character.reference
    ? posixJoin("characters", characterId, character.reference)
    : null;
  return { ok: true, rigs: character.headRig || {}, reference: refRel };
}

/**
 * Validate one timeline segment entry before it is persisted on a
 * character's headRig. Only checks shape/ranges here -- resolving the
 * referenced shot and its real frame count happens in shots.js at bake
 * time, since this module has no concept of shots.
 */
function normalizeStoredSegment(raw, isHead) {
  if (!raw || typeof raw !== "object") throw localError("Invalid segment");
  const shotId = String(raw.shotId || "").trim();
  if (!shotId) throw localError("segment.shotId is required");

  const inFrame = Number(raw.inFrame);
  const outFrame = Number(raw.outFrame);
  const start = Number(raw.start);
  if (!Number.isFinite(inFrame) || inFrame < 1) throw localError("segment.inFrame must be >= 1");
  if (!Number.isFinite(outFrame) || outFrame < inFrame) throw localError("segment.outFrame must be >= inFrame");
  if (!Number.isFinite(start) || start < 1) throw localError("segment.start must be >= 1");

  const seg = { shotId, inFrame, outFrame, start };
  if (isHead) {
    const anchorX = raw.anchorX == null ? 0.5 : Number(raw.anchorX);
    const anchorY = raw.anchorY == null ? 0.15 : Number(raw.anchorY);
    const headScale = raw.headScale == null ? 1.0 : Number(raw.headScale);
    if (!Number.isFinite(anchorX) || anchorX < 0 || anchorX > 1) throw localError("segment.anchorX must be 0-1");
    if (!Number.isFinite(anchorY) || anchorY < -0.5 || anchorY > 1.5) throw localError("segment.anchorY must be -0.5 to 1.5");
    if (!Number.isFinite(headScale) || headScale <= 0 || headScale > 5) throw localError("segment.headScale must be > 0 and <= 5");
    seg.anchorX = anchorX;
    seg.anchorY = anchorY;
    seg.headScale = headScale;
  }
  return seg;
}

/**
 * Save a head-rig entry for a character.
 *
 * Legacy single-pair body: { key, anchorX, anchorY, headScale, keyframes? }
 * New multi-segment body:  { key, bodySegments: [...], headSegments: [...] }
 * Both shapes can be present at once -- bodySegments/headSegments are added
 * alongside the legacy fields, never in place of them, so older saves (or
 * anything still reading anchorX/anchorY/headScale directly) keep working.
 * key = pose/angle identifier (e.g. "front", "left_34")
 */
function saveHeadRig(projectDir, globalAssetsDir, characterId, body) {
  if (!isSafeFolderName(characterId)) throw localError("Invalid character id");
  const patch = body && typeof body === "object" ? body : {};
  const key = String(patch.key || "").trim();
  if (!key) throw localError("key is required (e.g. 'front', 'left_34')");

  const hasSegments = Array.isArray(patch.bodySegments) || Array.isArray(patch.headSegments);

  const anchorXRaw = patch.anchorX;
  const anchorYRaw = patch.anchorY;
  const headScaleRaw = patch.headScale;
  const anchorX = anchorXRaw == null ? (hasSegments ? 0.5 : NaN) : Number(anchorXRaw);
  const anchorY = anchorYRaw == null ? (hasSegments ? 0.15 : NaN) : Number(anchorYRaw);
  const headScale = headScaleRaw == null ? (hasSegments ? 1.0 : NaN) : Number(headScaleRaw);
  if (!Number.isFinite(anchorX) || anchorX < 0 || anchorX > 1)
    throw localError("anchorX must be 0-1");
  if (!Number.isFinite(anchorY) || anchorY < -0.5 || anchorY > 1.5)
    throw localError("anchorY must be -0.5 to 1.5");
  if (!Number.isFinite(headScale) || headScale <= 0 || headScale > 5)
    throw localError("headScale must be > 0 and <= 5");

  // Validate keyframes if provided (legacy single-rig correction points)
  let keyframes = undefined;
  if (Array.isArray(patch.keyframes) && patch.keyframes.length > 0) {
    keyframes = patch.keyframes.map((kf) => {
      const frame = Number(kf.frame);
      const kfAx = Number(kf.anchorX);
      const kfAy = Number(kf.anchorY);
      const kfScale = Number(kf.headScale);
      if (!Number.isFinite(frame) || frame < 1) throw localError("keyframe.frame must be >= 1");
      if (!Number.isFinite(kfAx)) throw localError("keyframe.anchorX must be a number");
      if (!Number.isFinite(kfAy)) throw localError("keyframe.anchorY must be a number");
      if (!Number.isFinite(kfScale) || kfScale <= 0) throw localError("keyframe.headScale must be > 0");
      return { frame, anchorX: kfAx, anchorY: kfAy, headScale: kfScale };
    });
  }

  // Validate the new multi-segment timeline, if provided
  let bodySegments;
  let headSegments;
  if (Array.isArray(patch.bodySegments)) {
    bodySegments = patch.bodySegments.map((s) => normalizeStoredSegment(s, false));
  }
  if (Array.isArray(patch.headSegments)) {
    headSegments = patch.headSegments.map((s) => normalizeStoredSegment(s, true));
  }

  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  if (!character.headRig) character.headRig = {};
  const entry = { anchorX, anchorY, headScale };
  if (keyframes) entry.keyframes = keyframes;
  if (bodySegments) entry.bodySegments = bodySegments;
  if (headSegments) entry.headSegments = headSegments;
  character.headRig[key] = entry;

  writeCharacterJson(projectDir, characterId, character, null);
  return { ok: true, key, anchorX, anchorY, headScale, keyframes, bodySegments, headSegments, rigs: character.headRig };
}

/**
 * Delete a head-rig entry.
 */
function deleteHeadRig(projectDir, globalAssetsDir, characterId, key) {
  if (!isSafeFolderName(characterId)) throw localError("Invalid character id");
  if (!key) throw localError("key is required");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  if (character.headRig) {
    delete character.headRig[key];
  }
  writeCharacterJson(projectDir, characterId, character, null);
  return { ok: true, rigs: character.headRig || {} };
}

module.exports = {
  REFERENCE_DIR,
  SLOT_NAME,
  localError,
  characterDir,
  backupIfExists,
  readWritableCharacter,
  writeCharacterJson,
  findSlotSpec,
  characterReferenceRel,
  saveCharacterStyle,
  saveCharacterReference,
  saveSlotAlignment,
  loadHeadRig,
  saveHeadRig,
  deleteHeadRig,
  decodeImageBuffer,
};
