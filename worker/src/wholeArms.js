"use strict";

/**
 * Whole-arm rig: one Arms section, each drawing a shoulder-to-hand pose.
 * Remaps nested arm_upper/lower/hand pieces, writes draft mic-arm poses,
 * audits overlays, and installs animated Action Shot JSON.
 */

const fs = require("fs");
const path = require("path");

const { encodeRgbaPng } = require("./pngFlip");
const { setDrawingState } = require("./characterStatus");
const { posixJoin } = require("./assetIngest");
const { moveToProjectTrash } = require("./projectTrash");
const { findDrawingUsages } = require("./assetEditor");
const { decodeRgbaFile } = require("./factoryThumb");
const { isOverlayPiece, childRowLabel } = require("./factoryStandard");

const SKIN = [196, 140, 96];
const SLEEVE = [150, 28, 28];
const KNUCKLE = [176, 118, 80];
const THUMB = [210, 150, 110];
const MIC = [40, 40, 48];
const MIC_HEAD = [200, 200, 210];

function fillRect(rgba, width, x, y, w, h, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, x0 + Math.round(w));
  const y1 = Math.min(rgba.length / (width * 4), y0 + Math.round(h));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const o = (yy * width + xx) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

function fillEllipse(rgba, width, height, cx, cy, rx, ry, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(height - 1, Math.ceil(cy + ry));
  const rr = rx * rx || 1;
  const hh = ry * ry || 1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = (x - cx) * (x - cx) / rr;
      const dy = (y - cy) * (y - cy) / hh;
      if (dx + dy > 1) continue;
      const o = (y * width + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

function emptyRgba() {
  return Buffer.alloc(1024 * 1024 * 4);
}

function drawSleeveAndForearm(rgba, shoulder, elbow, wrist, sleeveLen) {
  const [sx, sy] = shoulder;
  const [ex, ey] = elbow;
  const [wx, wy] = wrist;
  fillEllipse(rgba, 1024, 1024, sx, sy, 28, 22, ...SLEEVE);
  fillRect(rgba, 1024, Math.min(sx, ex) - 16, Math.min(sy, ey) - 8, Math.abs(ex - sx) + 32, Math.abs(ey - sy) + 28, ...SLEEVE);
  fillEllipse(rgba, 1024, 1024, ex, ey, 18, 16, ...SLEEVE);
  const skinStart = sleeveLen || 0.55;
  const fx = ex + (wx - ex) * skinStart;
  const fy = ey + (wy - ey) * skinStart;
  fillRect(rgba, 1024, Math.min(ex, fx) - 12, Math.min(ey, fy) - 8, Math.abs(fx - ex) + 24, Math.abs(fy - ey) + 22, ...SLEEVE);
  fillRect(rgba, 1024, Math.min(fx, wx) - 11, Math.min(fy, wy) - 8, Math.abs(wx - fx) + 22, Math.abs(wy - fy) + 20, ...SKIN);
  fillEllipse(rgba, 1024, 1024, wx, wy, 16, 14, ...SKIN);
}

function drawKnucklesOut(rgba, hx, hy, facing) {
  const dir = facing === "left" ? -1 : 1;
  fillEllipse(rgba, 1024, 1024, hx, hy, 22, 16, ...SKIN);
  for (let i = 0; i < 4; i += 1) {
    fillRect(rgba, 1024, hx + dir * 6, hy - 12 + i * 7, 14, 5, ...KNUCKLE);
  }
  fillEllipse(rgba, 1024, 1024, hx + dir * 2, hy - 20, 10, 8, ...THUMB);
}

function drawMic(rgba, x, y) {
  fillRect(rgba, 1024, x - 4, y - 8, 8, 36, ...MIC);
  fillEllipse(rgba, 1024, 1024, x, y - 16, 16, 12, ...MIC_HEAD);
}

/** Knuckles OUT, thumb on top, sleeve joined — not a backwards floating hand. */
function drawWholeArm(pose, side = "L") {
  const rgba = emptyRgba();
  const left = side === "L";
  const shoulder = left ? [430, 500] : [600, 500];
  const poses = {
    rest: { elbow: left ? [410, 620] : [620, 620], wrist: left ? [400, 720] : [630, 720], grip: false, reach: false },
    reach: { elbow: left ? [360, 560] : [670, 560], wrist: left ? [300, 600] : [730, 600], grip: false, reach: true },
    grasp: { elbow: left ? [350, 540] : [680, 540], wrist: left ? [280, 520] : [750, 520], grip: false, reach: true },
    grip_mic: { elbow: left ? [360, 530] : [670, 530], wrist: left ? [300, 480] : [730, 480], grip: true, reach: true },
    hold_mic: { elbow: left ? [370, 520] : [660, 520], wrist: left ? [320, 450] : [710, 450], grip: true, reach: true },
    point_up: { elbow: left ? [400, 480] : [630, 480], wrist: left ? [390, 360] : [640, 360], grip: false, reach: false },
    raised_high: { elbow: left ? [410, 420] : [620, 420], wrist: left ? [400, 300] : [630, 300], grip: false, reach: false },
  };
  const spec = poses[pose] || poses.rest;
  drawSleeveAndForearm(rgba, shoulder, spec.elbow, spec.wrist, spec.reach ? 0.45 : 0.6);
  const [wx, wy] = spec.wrist;
  if (spec.grip) {
    drawMic(rgba, wx + (left ? -8 : 8), wy + 6);
    drawKnucklesOut(rgba, wx, wy, left ? "right" : "left");
  } else {
    drawKnucklesOut(rgba, wx, wy, left ? "right" : "left");
    if (pose === "point_up" || pose === "raised_high") {
      fillRect(rgba, 1024, wx - 3, wy - 40, 6, 36, ...SKIN);
    }
  }
  return rgba;
}

function writePng(abs, rgba) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, encodeRgbaPng(1024, 1024, rgba));
}

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function writeJson(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
}

const MIC_ARM_POSES = [
  { pose: "rest", side: "L", name: "rest_L" },
  { pose: "rest", side: "R", name: "rest_R" },
  { pose: "reach", side: "L", name: "reach_L" },
  { pose: "grasp", side: "L", name: "grasp_L" },
  { pose: "grip_mic", side: "L", name: "grip_mic_L" },
  { pose: "hold_mic", side: "L", name: "hold_mic_L" },
  { pose: "point_up", side: "L", name: "point_up_L" },
  { pose: "raised_high", side: "L", name: "raised_high_L" },
];

function installWholeArmDrawings(projectDir, characterId = "rodney") {
  const armDir = path.join(projectDir, "characters", characterId, "arm");
  fs.mkdirSync(armDir, { recursive: true });
  const written = [];
  for (const item of MIC_ARM_POSES) {
    const abs = path.join(armDir, `${item.name}.png`);
    writePng(abs, drawWholeArm(item.pose, item.side));
    setDrawingState(projectDir, characterId, `arm/${item.name}`, "draft");
    written.push(posixJoin("characters", characterId, "arm", `${item.name}.png`));
  }
  return written;
}

function isArmChild(child) {
  const label = childRowLabel(child);
  return label === "Arms" || /^Arm rig/.test(label) || label === "Hands";
}

function overlayKeepReason(child) {
  const text = `${(child && child.id) || ""} ${(child && child.asset) || ""}`.toLowerCase();
  if (/shirt|ov_shirt/.test(text)) return "Shirt overlay still sits on the armless torso.";
  if (/shorts|ov_shorts/.test(text)) return "Shorts overlay still sits on the legs/hips.";
  if (/cape/.test(text)) return "Cape is a separate clothing layer, not part of the arm.";
  if (/torso_rig/.test(text)) return null;
  if (isOverlayPiece(child)) return "Clothing overlay on the body, independent of whole arms.";
  return null;
}

function auditOverlays(projectDir, globalAssetsDir, characterId, character) {
  const keep = [];
  const drop = [];
  for (const child of character.children || []) {
    if (!isOverlayPiece(child)) continue;
    const reason = overlayKeepReason(child);
    const usages = findDrawingUsages(projectDir, globalAssetsDir, characterId, child.id, fileStem(child.asset) || child.id);
    const used = (usages || []).some((item) => item.kind === "script" || item.kind === "action");
    if (!reason && !used) {
      drop.push({ id: child.id, asset: child.asset, reason: "Only existed to parent split arm pieces." });
    } else {
      keep.push({ id: child.id, asset: child.asset, reason: reason || "Still referenced in a script or action." });
    }
  }
  return { keep, drop };
}

function fileStem(asset) {
  return path.basename(String(asset || ""), path.extname(String(asset || "")));
}

function remapActionJson(action) {
  const next = { ...action };
  const joints = { ...(action.joints || {}) };
  const hadArmJoints = Object.keys(joints).some((key) => /arm|hand/i.test(key));
  for (const key of Object.keys(joints)) {
    if (/arm|hand/i.test(key)) delete joints[key];
  }
  next.joints = Object.keys(joints).length ? joints : undefined;
  if (!next.joints) delete next.joints;

  const slotFrames = { ...(action.slot_frames || {}) };
  for (const key of Object.keys(slotFrames)) {
    if (/^hand/.test(key) || /^arm_/.test(key) && key !== "arm_L" && key !== "arm_R") {
      delete slotFrames[key];
    }
  }
  if (action.id === "grab_mic" || hadArmJoints && /grab/.test(String(action.id))) {
    next.frames = 4;
    next.fps = next.fps || 12;
    next.end = "hold";
    next.set_slots = { ...(next.set_slots || {}), torso: next.set_slots && next.set_slots.torso ? next.set_slots.torso : "armless_L" };
    slotFrames.arm_L = ["reach_L", "grasp_L", "grip_mic_L", "hold_mic_L"];
  } else if (action.id === "hold_mic") {
    next.frames = 3;
    next.fps = next.fps || 12;
    next.end = "hold";
    slotFrames.arm_L = ["grip_mic_L", "hold_mic_L", "grip_mic_L"];
  } else if (action.id === "look_left") {
    next.frames = 3;
    next.fps = next.fps || 8;
    slotFrames.eyes = ["open", "look_left", "look_left"];
  } else if (action.id === "look_right") {
    next.frames = 3;
    next.fps = next.fps || 8;
    slotFrames.eyes = ["open", "look_right", "look_right"];
  }
  if (Object.keys(slotFrames).length) next.slot_frames = slotFrames;
  return next;
}

function writeLookEyes(projectDir, characterId) {
  const dir = path.join(projectDir, "characters", characterId, "eyes_front");
  fs.mkdirSync(dir, { recursive: true });
  const openAbs = path.join(dir, "open.png");
  let base = Buffer.alloc(1024 * 1024 * 4);
  if (fs.existsSync(openAbs)) {
    try {
      const decoded = decodeRgbaFile(openAbs);
      if (decoded && decoded.width === 1024) base = Buffer.from(decoded.rgba);
    } catch {
      /* draw from scratch */
    }
  }
  function shifted(dx) {
    const rgba = Buffer.from(base);
    fillRect(rgba, 1024, 468 + dx, 318, 28, 14, 20, 18, 16, 255);
    fillRect(rgba, 1024, 532 + dx, 318, 28, 14, 20, 18, 16, 255);
    return rgba;
  }
  if (!fs.existsSync(path.join(dir, "look_left.png"))) {
    writePng(path.join(dir, "look_left.png"), shifted(-10));
    setDrawingState(projectDir, characterId, "eyes_front/look_left", "draft");
  }
  if (!fs.existsSync(path.join(dir, "look_right.png"))) {
    writePng(path.join(dir, "look_right.png"), shifted(10));
    setDrawingState(projectDir, characterId, "eyes_front/look_right", "draft");
  }
}

function writeWalkAction(actionsDir, id, view, frames, drawings) {
  const body = {
    id,
    view,
    fps: 12,
    frames: drawings.length,
    slot_frames: { torso: drawings },
  };
  writeJson(path.join(actionsDir, `${id}.json`), body);
}

function numberedDrawings(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => new RegExp(`^${prefix}_\\d+\\.png$`, "i").test(name))
    .sort()
    .map((name) => path.basename(name, ".png"));
}

function installWalkAndLookActions(projectDir, characterId) {
  const charDir = path.join(projectDir, "characters", characterId);
  const actionsDir = path.join(charDir, "actions");
  fs.mkdirSync(actionsDir, { recursive: true });
  writeLookEyes(projectDir, characterId);
  writeJson(path.join(actionsDir, "look_left.json"), {
    id: "look_left",
    view: "front",
    fps: 8,
    frames: 3,
    slot_frames: { eyes: ["open", "look_left", "look_left"] },
  });
  writeJson(path.join(actionsDir, "look_right.json"), {
    id: "look_right",
    view: "front",
    fps: 8,
    frames: 3,
    slot_frames: { eyes: ["open", "look_right", "look_right"] },
  });
  writeJson(path.join(actionsDir, "grab_mic.json"), {
    id: "grab_mic",
    view: "front",
    fps: 12,
    frames: 4,
    end: "hold",
    set_slots: { torso: "armless_L" },
    slot_frames: { arm_L: ["reach_L", "grasp_L", "grip_mic_L", "hold_mic_L"] },
    prop_events: [
      { frame: 2, prop: "{prop}", drawing: "pole" },
      { frame: 2, prop: "{prop}", z: 5 },
    ],
  });
  writeJson(path.join(actionsDir, "hold_mic.json"), {
    id: "hold_mic",
    view: "front",
    fps: 12,
    frames: 3,
    end: "hold",
    set_slots: { torso: "armless_L" },
    slot_frames: { arm_L: ["grip_mic_L", "hold_mic_L", "grip_mic_L"] },
  });
  const torsoDir = path.join(charDir, "torso");
  for (const [id, prefix, view] of [
    ["walk_front", "walk_front", "front"],
    ["walk_back", "walk_back", "back"],
    ["walk_side", "walk_side", "right_side"],
  ]) {
    const drawings = numberedDrawings(torsoDir, prefix);
    if (drawings.length >= 2) writeWalkAction(actionsDir, id, view, drawings.length, drawings);
  }
}

function installLongStrideDrafts(projectDir, characterId) {
  const charDir = path.join(projectDir, "characters", characterId);
  const actionsDir = path.join(charDir, "actions");
  fs.mkdirSync(actionsDir, { recursive: true });
  const written = [];
  for (const frames of [8, 12, 16]) {
    const id = `walk_side_long_stride_${frames}`;
    const names = [];
    const dir = path.join(charDir, "torso");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= frames; i += 1) {
      const name = `${id}_${String(i).padStart(2, "0")}`;
      const rgba = emptyRgba();
      const bounce = i % 2 === 0 ? 8 : 0;
      const stride = ((i - 1) % 4) * 12;
      fillRect(rgba, 1024, 430, 470 + bounce, 170, 220, 150, 28, 28);
      fillRect(rgba, 1024, 450 - stride, 700 + bounce, 28, 90, 40, 20, 10);
      fillRect(rgba, 1024, 530 + stride, 700 + bounce, 28, 90, 40, 20, 10);
      fillRect(rgba, 1024, 448, 248, 136, 150, ...SKIN);
      writePng(path.join(dir, `${name}.png`), rgba);
      setDrawingState(projectDir, characterId, `torso/${name}`, "draft");
      names.push(name);
    }
    writeJson(path.join(actionsDir, `${id}.json`), {
      id,
      view: "right_side",
      fps: 12,
      frames,
      distance_per_cycle: 96,
      slot_frames: { torso: names },
    });
    written.push(id);
  }
  return written;
}

function trashUnreferencedApproach(projectDir, globalAssetsDir, characterId) {
  const usages = findDrawingUsages(projectDir, globalAssetsDir, characterId, "torso", "approach");
  const blocking = (usages || []).filter((item) => item.kind === "script" || item.kind === "action" || item.kind === "rig");
  if (blocking.length) return { trashed: false, usages: blocking };
  const abs = path.join(projectDir, "characters", characterId, "torso", "approach.png");
  if (!fs.existsSync(abs)) return { trashed: false, missing: true };
  const { deleteDrawing } = require("./assetEditor");
  const result = deleteDrawing(projectDir, globalAssetsDir, characterId, "torso", "approach", { confirm: true, force: true });
  return { trashed: true, trash: result.trash };
}

function promoteWholeArms(projectDir, options = {}) {
  const characterId = options.characterId || "rodney";
  const charDir = path.join(projectDir, "characters", characterId);
  const jsonAbs = path.join(charDir, "character.json");
  if (!fs.existsSync(jsonAbs)) {
    const err = new Error(`No character.json for ${characterId}`);
    err.code = "ENOTFOUND";
    throw err;
  }
  const character = readJson(jsonAbs);
  const globalAssetsDir = options.globalAssetsDir || null;
  const drawings = installWholeArmDrawings(projectDir, characterId);
  const overlay = auditOverlays(projectDir, globalAssetsDir, characterId, character);

  const keptChildren = [];
  const dropped = [];
  for (const child of character.children || []) {
    if (isArmChild(child)) {
      dropped.push(child);
      continue;
    }
    const drop = overlay.drop.find((item) => item.id === child.id);
    if (drop) {
      dropped.push(child);
      continue;
    }
    keptChildren.push(child);
  }

  keptChildren.push(
    {
      id: "arm_L",
      asset: "arm/rest_L.png",
      z: 2,
      offset: { x: -12, y: -8 },
      pivot: { x: 430, y: 500 },
      slots: {
        arm_L: { offset: { x: 0, y: 0 }, drawings_dir: "arm", default_drawing: "rest_L" },
      },
    },
    {
      id: "arm_R",
      asset: "arm/rest_R.png",
      z: 2,
      offset: { x: 12, y: -8 },
      pivot: { x: 600, y: 500 },
      slots: {
        arm_R: { offset: { x: 0, y: 0 }, drawings_dir: "arm", default_drawing: "rest_R" },
      },
    }
  );
  character.children = keptChildren;
  if (!character.slots) character.slots = {};
  for (const name of ["hand", "hands", "hand_L", "hand_R", "left_hand", "right_hand", "mic_arm"]) {
    if (character.slots[name]) delete character.slots[name];
  }
  writeJson(jsonAbs, character);

  const actionsDir = path.join(charDir, "actions");
  if (fs.existsSync(actionsDir)) {
    for (const file of fs.readdirSync(actionsDir).filter((name) => name.endsWith(".json"))) {
      const abs = path.join(actionsDir, file);
      try {
        const action = readJson(abs);
        writeJson(abs, remapActionJson(action));
      } catch {
        /* skip */
      }
    }
  }
  installWalkAndLookActions(projectDir, characterId);

  const trashRels = [];
  const leftoverHand = path.join(charDir, "hand");
  if (fs.existsSync(leftoverHand)) {
    for (const file of fs.readdirSync(leftoverHand)) {
      if (!/\.png$/i.test(file)) continue;
      const stem = path.basename(file, ".png");
      const usages = findDrawingUsages(projectDir, globalAssetsDir, characterId, "hand", stem);
      const used = (usages || []).some((item) => item.kind === "script" || item.kind === "action");
      if (!used) trashRels.push(posixJoin("characters", characterId, "hand", file));
    }
  }
  for (const child of dropped) {
    if (!child.asset) continue;
    const rel = posixJoin("characters", characterId, String(child.asset).replace(/\\/g, "/"));
    const usages = findDrawingUsages(projectDir, globalAssetsDir, characterId, child.id, fileStem(child.asset));
    const used = (usages || []).some((item) => item.kind === "script" || item.kind === "action");
    if (/\/arm\//.test(rel)) continue;
    if (!used && fs.existsSync(path.join(projectDir, rel))) trashRels.push(rel);
  }
  let trash = null;
  if (trashRels.length) {
    try {
      trash = moveToProjectTrash(projectDir, trashRels);
    } catch {
      trash = null;
    }
  }
  const approach = trashUnreferencedApproach(projectDir, globalAssetsDir, characterId);
  return {
    drawings,
    overlay,
    dropped: dropped.map((item) => item.id),
    trash,
    approach,
  };
}

module.exports = {
  drawWholeArm,
  installWholeArmDrawings,
  promoteWholeArms,
  auditOverlays,
  remapActionJson,
  installWalkAndLookActions,
  installLongStrideDrafts,
  trashUnreferencedApproach,
  MIC_ARM_POSES,
};
