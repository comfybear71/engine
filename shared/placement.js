/**
 * Shared Stage/CLI placement math.
 *
 * Studio draws the Stage preview on a canvas from a preview-graph plus
 * cached textures. The CLI compositor uses the same formulas in Python.
 * Lock tests compare both on the same graph so they cannot drift.
 */

export const ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export const DEFAULT_MOUTH = "X";
export const NONE_DRAWING = "none";
export const MOUTH_SHAPES = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];
export const PREFERRED_FALLBACK = { H: ["C", "D", "B", "G", "E", "F", "A", "X"] };
export const LEGACY_FULL_HEAD_SLOTS = new Set(["head", "face", "eyes"]);
export const HEAD_BOB_SPAN = 6;
export const HEAD_BOB_PEAK = 2;

export function applyEase(t, ease) {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  if (ease === "inout") return u * u * (3 - 2 * u);
  return u;
}

export function interpolateScalar(keys, frame, fallback) {
  if (!keys || !keys.length) return fallback;
  const resolved = [...keys].sort((a, b) => a[0] - b[0]);
  if (frame <= resolved[0][0]) return resolved[0][1];
  if (frame >= resolved[resolved.length - 1][0]) return resolved[resolved.length - 1][1];
  for (let i = 0; i < resolved.length - 1; i += 1) {
    const [f0, v0, ease0] = resolved[i];
    const [f1, v1] = resolved[i + 1];
    if (f0 <= frame && frame <= f1) {
      const t = f1 === f0 ? 0 : (frame - f0) / (f1 - f0);
      return v0 + (v1 - v0) * applyEase(t, ease0);
    }
  }
  return resolved[resolved.length - 1][1];
}

export function rotateOffsetClockwise(x, y, degrees) {
  if (Math.abs(degrees) < 1e-9) return [x, y];
  const theta = (degrees * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return [x * cosT - y * sinT, x * sinT + y * cosT];
}

export function anchorOffset(anchor, width, height) {
  const name = ANCHORS.includes(anchor) ? anchor : "center";
  const [vertical, horizontal = "center"] = name.split("-");
  const ax = { left: 0, center: width / 2, right: width }[horizontal];
  const ay = { top: 0, center: height / 2, bottom: height }[vertical];
  return [ax, ay];
}

export function cameraView(camera, canvasW, canvasH, frame, fps) {
  const midX = canvasW / 2;
  const midY = canvasH / 2;
  if (!camera) return { cx: midX, cy: midY, zoom: 1, canvasW, canvasH, isIdentity: true };
  let [cx, cy, zoom] = interpolateCamera(camera.keyframes || [], frame, canvasW, canvasH);
  const [dx, dy] = shakeOffset(camera.shake, frame, fps);
  [cx, cy, zoom] = clampView(cx + dx, cy + dy, zoom, canvasW, canvasH);
  const isIdentity = Math.abs(zoom - 1) < 1e-9 && Math.abs(cx - midX) < 1e-9 && Math.abs(cy - midY) < 1e-9;
  return { cx, cy, zoom, canvasW, canvasH, isIdentity };
}

export function mapPlacement(view, x, y, scale) {
  if (!view || view.isIdentity) return [x, y, scale];
  const z = view.zoom;
  return [view.canvasW / 2 + (x - view.cx) * z, view.canvasH / 2 + (y - view.cy) * z, scale * z];
}

function interpolateCamera(keyframes, frame, canvasW, canvasH) {
  if (!keyframes.length) return [canvasW / 2, canvasH / 2, 1];
  const resolved = [...keyframes]
    .sort((a, b) => a.frame - b.frame)
    .map((k) => [k.frame, k.x == null ? canvasW / 2 : k.x, k.y == null ? canvasH / 2 : k.y, k.zoom ?? 1, k.ease || "linear"]);
  if (frame <= resolved[0][0]) return resolved[0].slice(1, 4);
  if (frame >= resolved[resolved.length - 1][0]) return resolved[resolved.length - 1].slice(1, 4);
  for (let i = 0; i < resolved.length - 1; i += 1) {
    const [f0, x0, y0, z0, ease0] = resolved[i];
    const [f1, x1, y1, z1] = resolved[i + 1];
    if (f0 <= frame && frame <= f1) {
      const t = applyEase(f1 === f0 ? 0 : (frame - f0) / (f1 - f0), ease0);
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t];
    }
  }
  return resolved[resolved.length - 1].slice(1, 4);
}

function shakeOffset(shake, frame, fps) {
  if (!shake || !(shake.amplitude_px > 0)) return [0, 0];
  if (frame < (shake.start_frame || 0)) return [0, 0];
  if (shake.end_frame != null && frame >= shake.end_frame) return [0, 0];
  const t = frame / Math.max(fps || 24, 1);
  const angle = 2 * Math.PI * (shake.frequency_hz || 8) * t;
  return [shake.amplitude_px * Math.sin(angle), shake.amplitude_px * Math.cos(angle * 1.3)];
}

function clampView(cx, cy, zoom, canvasW, canvasH) {
  const z = Math.max(Number(zoom) || 1, 1e-3);
  const cropW = canvasW / z;
  const cropH = canvasH / z;
  let x0 = cx - cropW / 2;
  let y0 = cy - cropH / 2;
  if (cropW <= canvasW) x0 = Math.min(Math.max(x0, 0), canvasW - cropW);
  else x0 = -(canvasW - cropW) / 2;
  if (cropH <= canvasH) y0 = Math.min(Math.max(y0, 0), canvasH - cropH);
  else y0 = -(canvasH - cropH) / 2;
  return [x0 + cropW / 2, y0 + cropH / 2, z];
}

export function transformAt(layer, localFrame) {
  const base = layer.transform || {};
  const kfs = layer.transformKeyframes || [];
  if (!kfs.length) {
    return {
      x: base.x || 0,
      y: base.y || 0,
      scale: base.scale == null ? 1 : base.scale,
      rotation: base.rotation || 0,
      flipX: !!base.flip_x,
      opacity: base.opacity == null ? 1 : base.opacity,
      anchor: base.anchor || "bottom-center",
    };
  }
  return {
    x: interpolateScalar(kfs.filter((k) => k.x != null).map((k) => [k.frame, k.x, k.ease]), localFrame, base.x || 0),
    y: interpolateScalar(kfs.filter((k) => k.y != null).map((k) => [k.frame, k.y, k.ease]), localFrame, base.y || 0),
    scale: interpolateScalar(
      kfs.filter((k) => k.scale != null).map((k) => [k.frame, k.scale, k.ease]),
      localFrame,
      base.scale == null ? 1 : base.scale
    ),
    rotation: interpolateScalar(
      kfs.filter((k) => k.rotation != null).map((k) => [k.frame, k.rotation, k.ease]),
      localFrame,
      base.rotation || 0
    ),
    flipX: !!base.flip_x,
    opacity: base.opacity == null ? 1 : base.opacity,
    anchor: base.anchor || "bottom-center",
  };
}

export function childRotationAt(child, localFrame) {
  const kfs = child.rotationKeyframes || [];
  if (!kfs.length) return child.rotation || 0;
  return interpolateScalar(
    kfs.map((k) => [k.frame, k.rotation, k.ease]),
    localFrame,
    child.rotation || 0
  );
}

export function groupRotationAt(layer, name, localFrame) {
  const base = Number((layer.groupRotations && layer.groupRotations[name]) || 0);
  const kfs = (layer.groupRotationKeyframes && layer.groupRotationKeyframes[name]) || [];
  if (!kfs.length) return base;
  return interpolateScalar(
    kfs.map((k) => [k.frame, k.rotation, k.ease]),
    localFrame,
    base
  );
}

export function layerViewAt(layer, localFrame) {
  let lastActive = null;
  for (const clip of layer.dialogue || []) {
    if (!clip.view) continue;
    const duration = clip.duration_frames || 0;
    if (clip.start_frame <= localFrame && localFrame < clip.start_frame + duration) lastActive = clip.view;
  }
  if (lastActive) return lastActive;
  let held = null;
  for (const key of layer.viewKeyframes || []) {
    if (key.frame <= localFrame) held = key.view;
    else break;
  }
  if (held) return held;
  let last = null;
  for (const clip of layer.dialogue || []) {
    if (clip.start_frame <= localFrame && clip.view) last = clip.view;
  }
  return last;
}

function childrenParentBeforeChild(children) {
  const byId = new Map(children.map((child) => [child.id, child]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(child) {
    if (visited.has(child.id) || visiting.has(child.id)) return;
    visiting.add(child.id);
    if (child.parent && byId.has(child.parent)) visit(byId.get(child.parent));
    visiting.delete(child.id);
    visited.add(child.id);
    ordered.push(child);
  }
  for (const child of children) visit(child);
  return ordered;
}

export function placeChildOnParent(parent, child, localFrame) {
  const childRot = childRotationAt(child, localFrame);
  const offsetRot = parent.flipX ? -parent.rotation : parent.rotation;
  const drawChildRot = parent.flipX ? -childRot : childRot;
  const mirroredX = parent.flipX ? -child.offset_x : child.offset_x;
  const [rx, ry] = rotateOffsetClockwise(mirroredX, child.offset_y || 0, offsetRot);
  return {
    z: child.z || 0,
    x: parent.x + rx * parent.scale,
    y: parent.y + ry * parent.scale,
    scale: parent.scale * (child.scale == null ? 1 : child.scale),
    flipX: parent.flipX !== !!child.flip_x,
    rotation: parent.rotation + drawChildRot,
    opacity: parent.opacity * (child.opacity == null ? 1 : child.opacity),
    anchor: child.pivot || "center",
    rel: child.rel,
    width: child.width,
    height: child.height,
    slots: child.slots || {},
    pivot: child.pivot_px || null,
  };
}

function visibleWhenMatches(visibleWhen, drawings) {
  if (!visibleWhen || !Object.keys(visibleWhen).length) return true;
  for (const [name, allowed] of Object.entries(visibleWhen)) {
    if (!allowed.includes(drawings[name])) return false;
  }
  return true;
}

export function resolveLayerPlacements(layer, localFrame, drawings) {
  const t = transformAt(layer, localFrame);
  const root = {
    z: 0,
    x: t.x,
    y: t.y,
    scale: t.scale,
    flipX: t.flipX,
    rotation: t.rotation,
    opacity: t.opacity,
    anchor: t.anchor,
    rel: layer.rel,
    width: layer.width,
    height: layer.height,
    slots: layer.slots || {},
    pivot: null,
  };
  const placements = [root];
  const placedById = new Map();
  const layerSpace = { ...root, slots: {} };
  for (const child of childrenParentBeforeChild(layer.children || [])) {
    if (drawings && !visibleWhenMatches(child.visible_when, drawings)) continue;
    let parentPlaced = layerSpace;
    if (child.parent) {
      if (!placedById.has(child.parent)) continue;
      parentPlaced = placedById.get(child.parent);
    }
    const placed = placeChildOnParent(parentPlaced, child, localFrame);
    placedById.set(child.id, placed);
    placements.push(placed);
  }
  return placements.sort((a, b) => a.z - b.z);
}

function isHide(drawing) {
  return Boolean(drawing) && String(drawing).trim().toLowerCase() === NONE_DRAWING;
}

function baseShape(shape) {
  const text = String(shape || DEFAULT_MOUTH);
  return text.endsWith("_loud") ? text.slice(0, -5) : text;
}

export function shapeAtTime(cues, tSeconds) {
  let chosen = DEFAULT_MOUTH;
  let found = false;
  for (const cue of cues || []) {
    if (cue.start <= tSeconds && tSeconds < cue.end) {
      chosen = cue.shape || DEFAULT_MOUTH;
      found = true;
      break;
    }
  }
  return found ? chosen : DEFAULT_MOUTH;
}

export function activeDrawing(slot, localFrame, fps) {
  if (slot.dialogue) {
    const clip = (slot.dialogue || []).find(
      (item) => item.start_frame <= localFrame && localFrame < item.start_frame + (item.duration_frames || 0)
    );
    if (!clip) return DEFAULT_MOUTH;
    return shapeAtTime(clip.cues, (localFrame - clip.start_frame) / Math.max(fps, 1));
  }
  if (slot.cues) return shapeAtTime(slot.cues, localFrame / Math.max(fps, 1));
  if (slot.keyframes && slot.keyframes.length) {
    let held = null;
    for (const kf of slot.keyframes) {
      if (kf.frame <= localFrame) held = kf;
      else break;
    }
    if (!held) return NONE_DRAWING;
    if (held.cycle && held.cycle.length) {
      const elapsed = Math.max(0, localFrame - held.frame);
      const cycleFps = held.fps != null ? held.fps : fps;
      return held.cycle[Math.floor((elapsed / Math.max(fps, 1)) * cycleFps) % held.cycle.length];
    }
    if (isHide(held.drawing) || !held.drawing) return NONE_DRAWING;
    return held.drawing;
  }
  return null;
}

export function resolveImage(slot, drawing, view) {
  if (isHide(drawing)) return null;
  const pools = [];
  const wanted = (view || "").trim() || null;
  const byView = slot.images_by_view || {};
  if (wanted) {
    if (byView[wanted]) pools.push(byView[wanted]);
    else if (wanted === "back" && Object.keys(byView).length) return null;
    if (wanted !== "front" && byView.front) pools.push(byView.front);
  } else if (byView.front) {
    pools.push(byView.front);
  }
  pools.push(slot.images || {});
  const names = [];
  if (drawing) {
    names.push(drawing);
    if (drawing.endsWith("_loud")) names.push(drawing.slice(0, -5));
  }
  for (const name of names) {
    for (const pool of pools) {
      if (pool[name]) return pool[name];
    }
  }
  for (const pool of pools) {
    if (pool[DEFAULT_MOUTH]) return pool[DEFAULT_MOUTH];
  }
  const first = Object.values(slot.images || {})[0];
  return first || null;
}

export function drawingAlign(slot, drawing) {
  const found = drawing && slot.align ? slot.align[drawing] : null;
  return { x: found?.x || 0, y: found?.y || 0, scale: found?.scale == null ? 1 : found.scale };
}

export function slotIsVisible(slot, drawings) {
  return visibleWhenMatches(slot.visible_when, drawings);
}

export function headBobAt(starts, frame, amp, rotation) {
  if (!amp && !rotation) return [0, 0];
  let dy = 0;
  let rot = 0;
  const span = HEAD_BOB_SPAN;
  const peak = Math.max(1, Math.min(HEAD_BOB_PEAK, span - 1));
  (starts || []).forEach((start, i) => {
    const t = frame - start;
    if (t < 0 || t > span) return;
    let u = t <= peak ? t / peak : 1 - (t - peak) / Math.max(1, span - peak);
    u = applyEase(u, "inout");
    dy = Math.max(dy, amp * u);
    rot += (i % 2 === 0 ? 1 : -1) * rotation * u;
  });
  return [dy, rot];
}

function collectDrawings(layer, localFrame, fps) {
  const drawings = {};
  for (const [name, slot] of Object.entries(layer.slots || {})) {
    drawings[name] = activeDrawing(slot, localFrame, fps);
  }
  for (const child of layer.children || []) {
    for (const [name, slot] of Object.entries(child.slots || {})) {
      drawings[name] = activeDrawing(slot, localFrame, fps);
    }
  }
  return drawings;
}

function sortedSlots(slots) {
  return Object.entries(slots || {}).sort((a, b, i, arr) => {
    void arr;
    const za = a[1].z == null ? 0 : a[1].z;
    const zb = b[1].z == null ? 0 : b[1].z;
    return za - zb;
  });
}

function suppressedHeadSlots(layer) {
  const group = layer.groups && layer.groups.head;
  if (!group) return new Set();
  const members = new Set(group);
  return new Set([...LEGACY_FULL_HEAD_SLOTS].filter((name) => !members.has(name)));
}

function slotCommand(slot, owner, localFrame, fps, drawings, view, groupRot, groupPivot, camera) {
  if (!slotIsVisible(slot, drawings)) return null;
  const drawing = activeDrawing(slot, localFrame, fps);
  if (drawing == null || isHide(drawing)) return null;
  let slotView = view;
  if (slotView == null && slot.dialogue) {
    const clip = slot.dialogue.find(
      (item) => item.start_frame <= localFrame && localFrame < item.start_frame + (item.duration_frames || 0)
    );
    slotView = clip?.view || null;
  }
  const image = resolveImage(slot, drawing, slotView);
  if (!image) return null;
  const align = drawingAlign(slot, drawing);
  const localX = (slot.offset_x || 0) + align.x;
  const localY = (slot.offset_y || 0) + align.y;
  const groupDraw = owner.flipX ? -groupRot : groupRot;
  const gx = groupPivot ? groupPivot[0] : localX;
  const gy = groupPivot ? groupPivot[1] : localY;
  const mirroredX = owner.flipX ? -localX : localX;
  const mirroredGx = owner.flipX ? -gx : gx;
  const [rdx, rdy] = rotateOffsetClockwise(mirroredX - mirroredGx, localY - gy, groupDraw);
  const attX = mirroredGx + rdx;
  const attY = gy + rdy;
  const [rotX, rotY] = rotateOffsetClockwise(attX, attY, owner.rotation);
  const [bobDy, bobRot] = headBobAt(slot.head_bob_starts, localFrame, slot.head_bob_amp || 0, slot.head_bob_rotation || 0);
  let x = owner.x + rotX * owner.scale;
  let y = owner.y + rotY * owner.scale + bobDy;
  let scale = owner.scale * (slot.scale || 1) * (align.scale || 1);
  if (camera && !camera.isIdentity) [x, y, scale] = mapPlacement(camera, x, y, scale);
  const hasCanvas = slot.canvas_w != null && slot.pivot_x != null;
  return {
    kind: "sprite",
    rel: image.rel,
    width: image.width,
    height: image.height,
    x,
    y,
    scale,
    flipX: owner.flipX,
    rotation: owner.rotation + (slot.rotation || 0) + groupDraw + bobRot,
    opacity: owner.opacity,
    anchor: hasCanvas ? "top-left" : "center",
    pivot: hasCanvas ? [slot.pivot_x, slot.pivot_y] : null,
  };
}

function backgroundFit(mode, srcW, srcH, canvasW, canvasH) {
  const fitScale = mode === "contain" ? Math.min(canvasW / srcW, canvasH / srcH) : Math.max(canvasW / srcW, canvasH / srcH);
  const fittedW = Math.max(1, Math.round(srcW * fitScale));
  const fittedH = Math.max(1, Math.round(srcH * fitScale));
  const originX = mode === "contain" ? (canvasW - fittedW) / 2 : -Math.max(0, Math.floor((fittedW - canvasW) / 2));
  const originY = mode === "contain" ? (canvasH - fittedH) / 2 : -Math.max(0, Math.floor((fittedH - canvasH) / 2));
  return { fitScale, fittedW, fittedH, originX, originY };
}

export function sceneAtFrame(graph, frame) {
  let elapsed = 0;
  for (const scene of graph.scenes || []) {
    if (frame < elapsed + scene.totalFrames) {
      return { scene, localFrame: frame - elapsed, startFrame: elapsed };
    }
    elapsed += scene.totalFrames;
  }
  const last = graph.scenes[graph.scenes.length - 1];
  return { scene: last, localFrame: Math.max(0, last.totalFrames - 1), startFrame: elapsed - last.totalFrames };
}

/**
 * Destination rectangle for a background command, in canvas pixels.
 *
 * This is the rect `drawImage` must use. It is derived from the graph's
 * source width/height (the real asset, same as CLI `probe_size`), not
 * from a downscaled `?preview=1` texture. A 512px preview still covers
 * the 1920×1080 frame the same way `fit_to_canvas` does.
 */
export function backgroundDestRect(cmd, canvasW, canvasH) {
  const width = canvasW || 1920;
  const height = canvasH || 1080;
  const zoom = Number(cmd?.zoom) || 1;
  const srcW = Number(cmd?.width) || width;
  const srcH = Number(cmd?.height) || height;
  const cx = cmd?.cx == null ? width / 2 : Number(cmd.cx);
  const cy = cmd?.cy == null ? height / 2 : Number(cmd.cy);
  const originX = Number(cmd?.originX) || 0;
  const originY = Number(cmd?.originY) || 0;
  const sx = Number(cmd?.sx) || zoom;
  const sy = Number(cmd?.sy) || zoom;
  return {
    x: width / 2 + (originX - cx) * zoom,
    y: height / 2 + (originY - cy) * zoom,
    w: srcW * sx,
    h: srcH * sy,
  };
}

export function evaluateBackgroundRect(graph, frameIndex) {
  const evaluated = evaluateFrame(graph, frameIndex);
  const bg = (evaluated.commands || []).find((cmd) => cmd.kind === "bg");
  if (!bg) return null;
  return backgroundDestRect(bg, evaluated.canvas.width, evaluated.canvas.height);
}

/** Mirrors sequence_frame_index in worker/python/compositor/sequence.py. */
export function sequenceFrameIndex(sequence, localFrame, projectFps) {
  const files = (sequence && sequence.files) || [];
  const seconds = (Number(sequence.trimIn) || 0) + Math.max(0, localFrame) / Math.max(1, projectFps);
  const index = Math.floor(seconds * (Number(sequence.fps) || 24) + 1e-6);
  return Math.max(0, Math.min(index, files.length - 1));
}

export function evaluateFrame(graph, frameIndex) {
  const fps = graph.fps || 24;
  const canvasW = graph.canvas?.width || 1920;
  const canvasH = graph.canvas?.height || 1080;
  const total = graph.totalFrames || 1;
  const frame = Math.max(0, Math.min(Math.floor(frameIndex) || 0, total - 1));
  const { scene, localFrame } = sceneAtFrame(graph, frame);
  const step = Math.max(1, scene.frameStep || 1);
  const composed = localFrame - (localFrame % step);
  const view = cameraView(scene.camera, canvasW, canvasH, composed, fps);
  const bg = scene.background || {};
  const fit = backgroundFit(bg.fit || "cover", bg.width || canvasW, bg.height || canvasH, canvasW, canvasH);
  const commands = [
    {
      kind: "bg",
      rel: bg.rel,
      width: bg.width,
      height: bg.height,
      fit: bg.fit || "cover",
      cx: view.cx,
      cy: view.cy,
      zoom: view.zoom,
      originX: fit.originX,
      originY: fit.originY,
      sx: view.zoom * (fit.fittedW / Math.max(bg.width || 1, 1)),
      sy: view.zoom * (fit.fittedH / Math.max(bg.height || 1, 1)),
    },
  ];
  const drawCamera = view.isIdentity ? null : view;
  const suppressed = suppressedHeadSlots;
  for (const layer of [...(scene.layers || [])].sort((a, b) => (a.z || 0) - (b.z || 0))) {
    const end = layer.endFrame == null ? scene.totalFrames : layer.endFrame;
    if (composed < (layer.startFrame || 0) || composed >= end) continue;
    const local = composed - (layer.startFrame || 0);
    let drawLayer = layer;
    if (layer.sequence && layer.sequence.files && layer.sequence.files.length) {
      const index = sequenceFrameIndex(layer.sequence, local, fps);
      drawLayer = { ...layer, rel: layer.sequence.files[index] };
    }
    const drawings = collectDrawings(drawLayer, local, fps);
    const hidden = suppressed(drawLayer);
    const layerView = layerViewAt(drawLayer, local);
    const groupRotBySlot = {};
    const groupPivotBySlot = {};
    for (const [groupName, members] of Object.entries(layer.groups || {})) {
      const rot = groupRotationAt(layer, groupName, local);
      let pivotSlot = null;
      for (const member of members) {
        if (layer.slots && layer.slots[member]) {
          pivotSlot = layer.slots[member];
          break;
        }
        for (const child of layer.children || []) {
          if (child.slots && child.slots[member]) {
            pivotSlot = child.slots[member];
            break;
          }
        }
        if (pivotSlot) break;
      }
      const pivotXy = pivotSlot ? [pivotSlot.offset_x || 0, pivotSlot.offset_y || 0] : [0, 0];
      for (const member of members) {
        groupRotBySlot[member] = rot;
        groupPivotBySlot[member] = pivotXy;
      }
    }
    for (const placed of resolveLayerPlacements(drawLayer, local, drawings)) {
      let x = placed.x;
      let y = placed.y;
      let scale = placed.scale;
      if (drawCamera) [x, y, scale] = mapPlacement(drawCamera, x, y, scale);
      commands.push({
        kind: "sprite",
        rel: placed.rel,
        width: placed.width,
        height: placed.height,
        x,
        y,
        scale,
        flipX: placed.flipX,
        rotation: placed.rotation,
        opacity: placed.opacity,
        anchor: placed.pivot ? "top-left" : placed.anchor,
        pivot: placed.pivot,
      });
      for (const [name, slot] of sortedSlots(placed.slots)) {
        if (hidden.has(name)) continue;
        const cmd = slotCommand(
          slot,
          placed,
          local,
          fps,
          drawings,
          layerView,
          groupRotBySlot[name] || 0,
          groupPivotBySlot[name] || null,
          drawCamera
        );
        if (cmd) commands.push(cmd);
      }
    }
  }
  return { frame, canvas: { width: canvasW, height: canvasH }, fps, commands };
}

/**
 * Flipbook frames the next `count` project frames will need that are not the
 * frame already shown at `frameIndex`, so the preview can load them ahead of
 * playback instead of preloading whole sequences.
 */
export function sequenceLookahead(graph, frameIndex, count = 8) {
  const fps = graph.fps || 24;
  const total = graph.totalFrames || 1;
  const wanted = new Set();
  for (let step = 0; step <= count; step++) {
    const frame = Math.max(0, Math.min(Math.floor(frameIndex) + step, total - 1));
    const { scene, localFrame } = sceneAtFrame(graph, frame);
    const composed = localFrame - (localFrame % Math.max(1, scene.frameStep || 1));
    for (const layer of scene.layers || []) {
      const files = layer.sequence && layer.sequence.files;
      if (!files || !files.length) continue;
      const end = layer.endFrame == null ? scene.totalFrames : layer.endFrame;
      if (composed < (layer.startFrame || 0) || composed >= end) continue;
      wanted.add(files[sequenceFrameIndex(layer.sequence, composed - (layer.startFrame || 0), fps)]);
    }
  }
  return [...wanted];
}

export function collectRels(graph) {
  const rels = new Set();
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.rel === "string" && node.rel) rels.add(node.rel);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const value of Object.values(node)) walk(value);
  }
  walk(graph);
  return [...rels].sort();
}
