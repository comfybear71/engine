"use strict";

/**
 * Windowed low-res proxy segments for Stage play. Cached by script/asset
 * fingerprint + start + length + size. Rendered by the persistent
 * compositor process (in-Python frame loop, no per-frame HTTP).
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { fingerprintParseInputs, fingerprintAssets } = require("./parser/parseCache");
const { segmentViaSession } = require("./previewSession");

const SEGMENT_SEC = 25;
const SEGMENT_SIZE = { width: 960, height: 540 };

const jobs = new Map();

function segmentCacheDir() {
  const dir = path.join(os.tmpdir(), "engine-preview-segments");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function segmentCacheKey(projectDir, scriptName, startFrame, frames, width, height) {
  const parseFp = fingerprintParseInputs(projectDir, scriptName);
  const assetFp = fingerprintAssets(projectDir);
  return crypto
    .createHash("sha1")
    .update(`${parseFp}|${assetFp}|${startFrame}|${frames}|${width}|${height}`)
    .digest("hex");
}

function segmentFileForKey(key) {
  return path.join(segmentCacheDir(), `${key}.mp4`);
}

function isSafeSegmentFile(file) {
  return typeof file === "string" && /^[a-f0-9]{40}\.mp4$/i.test(file);
}

function resolveSegmentFile(file) {
  if (!isSafeSegmentFile(file)) return null;
  const abs = path.join(segmentCacheDir(), path.basename(file));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

function readProgressFile(progressPath) {
  try {
    return JSON.parse(fs.readFileSync(progressPath, "utf8"));
  } catch {
    return null;
  }
}

function describeJob(key) {
  const file = segmentFileForKey(key);
  const job = jobs.get(key);
  const progress = readProgressFile(`${file}.progress.json`);
  const fileReady = fs.existsSync(file) && fs.statSync(file).size > 32 && (!job || job.ready || (progress && progress.done));
  if (fileReady && job) {
    job.ready = true;
    job.progress = 1;
    job.framesDone = job.framesTotal;
  }
  const framesDone = (progress && progress.framesDone) || (job && job.framesDone) || 0;
  const framesTotal = (job && job.framesTotal) || (progress && progress.framesTotal) || 0;
  return {
    key,
    file: path.basename(file),
    abs: file,
    ready: Boolean(fileReady),
    progress: fileReady ? 1 : progress && progress.progress != null ? progress.progress : job ? job.progress : 0,
    framesDone,
    framesTotal,
    startFrame: job ? job.startFrame : null,
    frames: job ? job.frames : framesTotal || null,
    width: job ? job.width : null,
    height: job ? job.height : null,
    fps: job ? job.fps : null,
    error: job && job.error ? job.error : null,
  };
}

function requestPreviewSegment(projectDir, scriptName, options = {}) {
  const startFrame = Math.max(0, Math.floor(Number(options.startFrame) || 0));
  const fps = Math.max(1, Number(options.fps) || 24);
  const durationSec = Number(options.durationSec) > 0 ? Number(options.durationSec) : SEGMENT_SEC;
  const frames = Math.max(1, Math.floor(Number(options.frames) || Math.round(durationSec * fps)));
  const width = Math.max(2, Number(options.width) || SEGMENT_SIZE.width);
  const height = Math.max(2, Number(options.height) || SEGMENT_SIZE.height);
  const key = segmentCacheKey(projectDir, scriptName, startFrame, frames, width, height);
  const current = describeJob(key);
  if (current.ready) {
    return {
      ...current,
      startFrame,
      frames,
      width,
      height,
      fps,
    };
  }
  let job = jobs.get(key);
  if (!job || job.error) {
    const file = segmentFileForKey(key);
    const progressPath = `${file}.progress.json`;
    job = {
      ready: false,
      progress: 0,
      framesDone: 0,
      framesTotal: frames,
      startFrame,
      frames,
      width,
      height,
      fps,
      error: null,
    };
    jobs.set(key, job);
    job.promise = segmentViaSession(projectDir, {
      timeline: options.timeline,
      startFrame,
      frames,
      width,
      height,
      output: file,
      progressPath,
      pythonBin: options.pythonBin,
    })
      .then(() => {
        job.ready = true;
        job.progress = 1;
        job.framesDone = frames;
        return describeJob(key);
      })
      .catch((err) => {
        job.error = err.message || String(err);
        return describeJob(key);
      });
  }
  return {
    ...describeJob(key),
    startFrame,
    frames,
    width,
    height,
    fps,
  };
}

function resetPreviewSegments() {
  jobs.clear();
}

module.exports = {
  SEGMENT_SEC,
  SEGMENT_SIZE,
  segmentCacheKey,
  segmentCacheDir,
  isSafeSegmentFile,
  resolveSegmentFile,
  requestPreviewSegment,
  describeJob,
  resetPreviewSegments,
};
