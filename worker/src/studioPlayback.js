"use strict";

/**
 * Stage playback helpers: which render/proxy file to play, whether it is
 * newer than the selected script, and which audio-lane WAVs exist on disk.
 */

const fs = require("fs");
const path = require("path");

const { renderOutputName, previewOutputName } = require("./studioProjects");
const { readWavDurationSeconds } = require("./parser/wavDuration");

const PROXY_SIZE = { width: 960, height: 540 };

function candidateRenderFiles(scriptName) {
  const named = renderOutputName(scriptName);
  return named === "output.mp4" ? [named] : [named, "output.mp4"];
}

function renderFileInfo(projectDir, file) {
  const abs = path.join(projectDir, "renders", file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return { file, mtimeMs: fs.statSync(abs).mtimeMs };
}

function scriptMtimeMs(projectDir, scriptName) {
  const abs = path.join(projectDir, scriptName);
  if (!fs.existsSync(abs)) return 0;
  return fs.statSync(abs).mtimeMs;
}

function isUpToDate(fileMtimeMs, scriptTimeMs) {
  return Number.isFinite(fileMtimeMs) && Number.isFinite(scriptTimeMs) && fileMtimeMs >= scriptTimeMs;
}

function isSafeAudioRel(rel) {
  if (typeof rel !== "string" || !rel) return false;
  const posix = rel.replace(/\\/g, "/");
  if (posix.includes("..") || posix.startsWith("/") || posix.includes("//")) return false;
  if (!posix.startsWith("audio/")) return false;
  if (!/\.wav$/i.test(posix)) return false;
  return /^audio\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.wav$/i.test(posix);
}

function resolveProjectAudio(projectDir, rel) {
  if (!isSafeAudioRel(rel)) return null;
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, rel);
  const inside = path.relative(root, resolved);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function describeVideo(projectDir, file, scriptTimeMs) {
  const info = renderFileInfo(projectDir, file);
  if (!info) return null;
  return { file: info.file, upToDate: isUpToDate(info.mtimeMs, scriptTimeMs) };
}

function audioClipsFromLanes(projectDir, lanes) {
  const clips = [];
  for (const block of lanes.blocks || []) {
    if (block.lane !== "audio" || !block.rel) continue;
    if (!isSafeAudioRel(block.rel)) continue;
    const fps = Math.max(Number(lanes.fps) || 24, 1);
    const abs = resolveProjectAudio(projectDir, block.rel);
    clips.push({
      rel: block.rel,
      startFrame: block.startFrame,
      endFrame: block.endFrame,
      exists: Boolean(abs),
      durationSeconds: abs ? readWavDurationSeconds(abs) : null,
      trimInSec: ((block.trim && block.trim.inFrames) || 0) / fps,
      trimOutSec: block.trim && block.trim.outFrames ? block.trim.outFrames / fps : null,
    });
  }
  return clips;
}

function describePlayback(projectDir, scriptName, lanes) {
  const scriptTime = scriptMtimeMs(projectDir, scriptName);
  let render = null;
  for (const file of candidateRenderFiles(scriptName)) {
    render = describeVideo(projectDir, file, scriptTime);
    if (render) break;
  }
  return {
    fps: lanes.fps,
    totalFrames: lanes.totalFrames,
    render,
    proxy: describeVideo(projectDir, previewOutputName(scriptName), scriptTime),
    audio: audioClipsFromLanes(projectDir, lanes),
  };
}

module.exports = {
  PROXY_SIZE,
  previewOutputName,
  candidateRenderFiles,
  isUpToDate,
  isSafeAudioRel,
  resolveProjectAudio,
  describePlayback,
  scriptMtimeMs,
};
