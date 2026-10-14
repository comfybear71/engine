"use strict";

/**
 * Factory Import MP4: outside AI walk video → keyed gait cycle → Action Shot.
 * No xAI calls. ffmpeg extracts every frame; Python keys, scores, and fits.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { readWritableCharacter, findSlotSpec } = require("./characterLocal");
const { inferFactoryIntent, clampFactoryFrames, slugFactoryId } = require("./factoryPrompt");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");
const {
  factoryError,
  findCharacter,
  resolveActionDest,
  uniqueActionId,
  walkBob,
  drawingNames,
  findTorsoRef,
  findLegsRef,
  walkSetSlots,
  tickFactoryJob,
} = require("./factoryJob");
const factoryJob = require("./factoryJob");
const { parseMultipartBuffer, collectRawBody } = require("./importAudio");
const {
  uniqueClipId,
  clipDir,
  writeClipIndex,
  collectHeadFrames,
  inferCategoryFromAction,
} = require("./factoryLibrary");

function spawnCmd(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => reject(new Error(`Failed to spawn ${bin}: ${err.message}`)));
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runPythonJson(args, options = {}) {
  const pythonBin = options.pythonBin || resolvePythonBin();
  return spawnCmd(pythonBin, ["-m", "compositor.factory_import_mp4", ...args], { cwd: PYTHON_DIR }).then(
    ({ code, stdout, stderr }) => {
      const trimmed = stdout.trim();
      let parsed = null;
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed.split("\n").pop());
        } catch {
          parsed = null;
        }
      }
      if (code !== 0 || !parsed || parsed.ok === false) {
        const detail = (parsed && parsed.error) || (stderr || stdout).trim().split("\n").pop() || `exited ${code}`;
        throw factoryError(`Import MP4 failed: ${detail}`, "EINVAL");
      }
      return parsed;
    }
  );
}

function extractFrames(videoPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const pattern = path.join(destDir, "frame_%04d.png");
  return spawnCmd("ffmpeg", ["-y", "-i", videoPath, "-vsync", "0", pattern]).then(({ code, stderr }) => {
    const frames = fs.existsSync(destDir)
      ? fs.readdirSync(destDir).filter((name) => /^frame_\d+\.png$/i.test(name)).sort()
      : [];
    if (code !== 0 || !frames.length) {
      throw factoryError(stderr.trim().split("\n").pop() || "ffmpeg could not extract frames from this MP4.", "EINVAL");
    }
    return frames.map((name) => path.join(destDir, name));
  });
}

function slugImportActionId(filename, prompt, view, kind) {
  const fromFile = path
    .basename(String(filename || ""), path.extname(String(filename || "")))
    .toLowerCase()
    .replace(/^generated_video_?/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const fromPrompt = slugFactoryId(prompt, "");
  let base = fromFile || fromPrompt || "imported_walk";
  if (kind === "head") return base.slice(0, 48);
  const side = view === "left_side" ? "left_side" : "side";
  if (!/_side$|_left_side$/.test(base)) base = `${base}_${side}`;
  return base.slice(0, 48);
}

function neckYFromCharacter(character) {
  for (const name of ["head_base", "head", "torso"]) {
    const spec = character ? findSlotSpec(character, name) : null;
    const pivot = spec && spec.canvas && spec.canvas.pivot;
    if (pivot && Number.isFinite(Number(pivot.y))) return Math.round(Number(pivot.y));
  }
  return 457;
}

function decodeVideoBody(body) {
  if (body && typeof body.videoBase64 === "string" && body.videoBase64) {
    const stripped = body.videoBase64.replace(/^data:[^;]+;base64,/, "");
    return Buffer.from(stripped, "base64");
  }
  return null;
}

async function startImportMp4(projectDir, globalAssetsDir, body, options = {}) {
  const characterId = body && body.characterId;
  const character = findCharacter(projectDir, globalAssetsDir, characterId);
  const writable = readWritableCharacter(projectDir, globalAssetsDir, character.id);
  const prompt = String((body && (body.prompt || body.name)) || path.basename(body.filename || body.videoPath || "imported walk"))
    .replace(/\.[^.]+$/, "")
    .trim();
  const intent = inferFactoryIntent(prompt || "walk side");
  const view = (body && body.view) || intent.view || "right_side";
  let dest = resolveActionDest(writable, { kind: "walk", view });
  const framesWanted = clampFactoryFrames(body && body.frames);
  const jobId = factoryJob.stampJobId();
  const dir = factoryJob.jobDir(projectDir, character.id, jobId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  let videoPath = body && body.videoPath ? String(body.videoPath) : "";
  const uploaded = Buffer.isBuffer(body && body.videoBuffer) ? body.videoBuffer : decodeVideoBody(body);
  const stored = path.join(dir, "source.mp4");
  if (uploaded && uploaded.length > 32) {
    fs.writeFileSync(stored, uploaded);
    videoPath = stored;
  } else if (videoPath && fs.existsSync(videoPath) && path.resolve(videoPath) !== path.resolve(stored)) {
    fs.copyFileSync(videoPath, stored);
    videoPath = stored;
  }
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw factoryError("Choose an MP4 to import.", "ENOENT");
  }

  const extracted = path.join(dir, "frames");
  await extractFrames(stored, extracted);
  const filename = body.filename || path.basename(videoPath);
  const analysis = await runPythonJson(
    ["analyze", "--frames-dir", extracted, "--out-dir", dir, "--filename", filename],
    options
  );
  let catalog = null;
  try {
    const clipId = uniqueClipId(projectDir, character.id, filename || prompt);
    const libDir = clipDir(projectDir, character.id, clipId);
    catalog = await runPythonJson(
      ["catalog", "--frames-dir", extracted, "--out-dir", libDir, "--filename", filename, "--prompt", prompt],
      options
    );
    catalog.id = clipId;
    catalog.filename = filename;
    writeClipIndex(projectDir, character.id, clipId, { ...catalog, id: clipId, filename });
  } catch {
    catalog = null;
  }
  const clipKind = (catalog && catalog.kind) || "body";
  if (clipKind === "head") {
    dest = { kind: "slot", slot: "head_base", drawings_dir: "head_base" };
  }
  const suggested = (analysis.suggested && analysis.suggested[String(framesWanted)]) || [];
  const actionBase = slugImportActionId(filename || prompt, prompt, view, clipKind);
  const job = {
    id: jobId,
    mode: "character",
    kind: "import_mp4",
    usedImport: true,
    keepHead: true,
    characterId: character.id,
    userPrompt: prompt || actionBase,
    filename: body.filename || path.basename(videoPath),
    frames: framesWanted,
    dest,
    view,
    actionId: uniqueActionId(projectDir, character.id, actionBase),
    warnings: [...(analysis.warnings || []), ...((catalog && catalog.warnings) || [])],
    libraryClip: catalog && catalog.id,
    category: (catalog && catalog.category) || inferCategoryFromAction({ id: actionBase }),
    importMp4: {
      background: analysis.background,
      frameCount: analysis.frameCount,
      steady: analysis.steady,
      cycle: analysis.cycle,
      suggested: analysis.suggested,
      loopClosure: analysis.loopClosure,
      hasHead: analysis.hasHead,
      kind: clipKind,
      selected: suggested.slice(),
      thumbs: (analysis.thumbs || []).map((item) => ({
        index: item.index,
        rel: item.rel,
        hasHead: item.hasHead,
        boots: item.boots,
        blobs: item.blobs,
      })),
    },
    drawings: [],
    ticked: false,
    createdAt: new Date().toISOString(),
  };
  factoryJob.writeManifest(dir, job);
  const keys = suggested.length >= 2 ? suggested : clipKind === "head" && analysis.frameCount >= 2
    ? Array.from({ length: Math.min(framesWanted, analysis.frameCount) }, (_, i) =>
        Math.round((i / Math.max(1, framesWanted - 1)) * (analysis.frameCount - 1))
      )
    : [];
  if (keys.length >= 2) {
    return buildImportMp4(projectDir, globalAssetsDir, character.id, jobId, { indices: keys, frames: framesWanted }, options);
  }
  return factoryJob.describeFactoryJob(projectDir, character.id, jobId);
}

async function buildImportMp4(projectDir, globalAssetsDir, characterId, jobId, body, options = {}) {
  const job = factoryJob.readManifest(projectDir, characterId, jobId);
  if (job.ticked) throw factoryError("This one is already ticked.", "EINVAL");
  const character = readWritableCharacter(projectDir, globalAssetsDir, characterId);
  const dir = factoryJob.jobDir(projectDir, characterId, jobId);
  const dest = job.dest;
  const canvas = factoryJob.slotCanvas(character, dest);
  const framesWanted = clampFactoryFrames((body && body.frames) || job.frames);
  let indices = Array.isArray(body && body.indices) ? body.indices.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  if (indices.length < 2) {
    const suggested = job.importMp4 && job.importMp4.suggested && job.importMp4.suggested[String(framesWanted)];
    indices = Array.isArray(suggested) ? suggested : [];
  }
  if (indices.length < 2) throw factoryError("Tick at least two key frames in the strip.", "EINVAL");

  const keyedDir = path.join(dir, "keyed");
  const alignedDir = path.join(dir, "aligned");
  fs.rmSync(alignedDir, { recursive: true, force: true });
  const torsoRef = findTorsoRef(projectDir, characterId, job.view || "right_side");
  const legsRef = findLegsRef(projectDir, characterId, job.view || "right_side");
  const args = [
    "build",
    "--keyed-dir",
    keyedDir,
    "--out-dir",
    alignedDir,
    "--indices",
    indices.join(","),
    "--canvas-w",
    String(canvas.w),
    "--canvas-h",
    String(canvas.h),
    "--neck-y",
    String(neckYFromCharacter(character)),
  ];
  if (torsoRef) args.push("--torso-ref", torsoRef);
  if (legsRef) args.push("--legs-ref", legsRef);
  const isHeadClip = job.importMp4 && job.importMp4.kind === "head";
  const heads = isHeadClip ? [] : collectHeadFrames(projectDir, characterId);
  if (heads.length) {
    const clipHeads = heads.filter((item) => item.clipId === heads[0].clipId);
    args.push("--head-dir", path.dirname(clipHeads[0].path));
    args.push("--head-indices", clipHeads.map((item) => item.index).join(","));
    args.push("--head-yaws", clipHeads.map((item) => item.yaw).join(","));
  }
  const built = await runPythonJson(args, options);

  const actionId = job.actionId || uniqueActionId(projectDir, characterId, "imported_walk_side");
  const names = drawingNames(actionId, indices.length);
  const drawings = [];
  const cellsDir = path.join(dir, "cells");
  fs.mkdirSync(cellsDir, { recursive: true });
  for (let i = 0; i < indices.length; i += 1) {
    const row = (built.written || [])[i];
    if (!row || !row.src || !fs.existsSync(row.src)) continue;
    const cellPath = path.join(cellsDir, path.basename(row.src));
    fs.copyFileSync(row.src, cellPath);
    drawings.push({ name: names[i], path: row.src, problems: row.problems || [] });
  }
  if (drawings.length < 2) throw factoryError("Could not fit enough walk frames from this MP4.", "EINVAL");

  const isHead = dest.slot === "head_base" || isHeadClip;
  const setSlots = isHead ? {} : walkSetSlots(character, dest, { keepHead: true });
  const action = {
    id: actionId,
    view: job.view || "right_side",
    faces: (job.view || "right_side") === "left_side" ? "left" : "right",
    fps: 12,
    frames: drawings.length,
    distance_per_cycle: isHead ? undefined : Number(built.distance_per_cycle) || 96,
    slot_frames: { [dest.slot]: drawings.map((item) => item.name) },
    bob: isHead ? undefined : walkBob(drawings.length),
    hide_children: !isHead,
    set_slots: setSlots,
    category: job.category || inferCategoryFromAction({ id: actionId }),
    libraryClip: job.libraryClip || null,
    warnings: [...new Set([...(job.warnings || []), ...(built.problems || [])])],
  };
  if (!action.distance_per_cycle) delete action.distance_per_cycle;
  if (!action.bob) delete action.bob;
  if (!Object.keys(setSlots).length) delete action.set_slots;
  const warnings = [...(job.warnings || []), ...(built.problems || [])];
  const next = {
    ...job,
    frames: drawings.length,
    actionId,
    action,
    dest,
    drawings,
    warnings: [...new Set(warnings)],
    keepHead: true,
    usedImport: true,
    usedRig: false,
    usedGrok: false,
    usedFixture: Boolean(job.usedFixture),
    previewRel: null,
    importMp4: {
      ...(job.importMp4 || {}),
      selected: indices,
    },
  };
  factoryJob.writeManifest(dir, next);
  try {
    await factoryJob.renderJobPreview(projectDir, globalAssetsDir, character, next, options);
    next.previewRel = `characters/${characterId}/_factory/${jobId}/preview.mp4`;
    next.previewKind = "video";
    factoryJob.writeManifest(dir, next);
  } catch (err) {
    next.warnings = [...(next.warnings || []), err.message || "Preview clip failed"];
    factoryJob.writeManifest(dir, next);
  }
  return factoryJob.describeFactoryJob(projectDir, characterId, jobId);
}

function resolveImportStrip(projectDir, characterId, jobId, name) {
  const safe = String(name || "").replace(/[^A-Za-z0-9._-]/g, "");
  const abs = path.join(factoryJob.jobDir(projectDir, characterId, jobId), "strip", safe);
  if (!fs.existsSync(abs)) throw factoryError("Strip frame not found", "ENOENT");
  return abs;
}

function tickImportMp4(projectDir, globalAssetsDir, characterId, jobId) {
  return tickFactoryJob(projectDir, globalAssetsDir, characterId, jobId);
}

async function readImportMp4Request(req) {
  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    const buffer = await collectRawBody(req, 250 * 1024 * 1024);
    const parts = parseMultipartBuffer(buffer, ctype);
    const fields = {};
    let upload = null;
    for (const part of parts) {
      if (part.filename) upload = part;
      else fields[part.name] = part.data.toString("utf8");
    }
    return {
      characterId: String(fields.characterId || fields.character || "").trim(),
      prompt: String(fields.prompt || fields.name || "").trim(),
      frames: fields.frames,
      view: fields.view || undefined,
      filename: upload && upload.filename,
      videoBuffer: upload && upload.data.length ? upload.data : undefined,
      videoPath: String(fields.videoPath || fields.path || "").trim() || undefined,
    };
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  return {
    characterId: String(body.characterId || body.character || "").trim(),
    prompt: String(body.prompt || body.name || "").trim(),
    frames: body.frames,
    view: body.view,
    filename: body.filename,
    videoBase64: body.videoBase64,
    videoPath: body.videoPath || body.path,
  };
}

module.exports = {
  startImportMp4,
  buildImportMp4,
  resolveImportStrip,
  tickImportMp4,
  slugImportActionId,
  extractFrames,
  readImportMp4Request,
};
