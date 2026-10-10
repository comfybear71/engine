"use strict";

/**
 * Builds the ffmpeg argv that concatenates episode (or scene-trim) mp4s
 * into a show-level final cut. Sequence + per-item trim + optional gap
 * or crossfade. The worker never shells ffmpeg from a test — call
 * `buildFinalCutConcatArgs` and inspect the array.
 */

function formatTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return "0";
  return String(Math.round(n * 1000) / 1000);
}

function itemDurationSec(item) {
  const start = Number(item.trimInSec) > 0 ? Number(item.trimInSec) : 0;
  const end =
    item.trimOutSec != null && Number.isFinite(Number(item.trimOutSec))
      ? Number(item.trimOutSec)
      : Number(item.durationSec);
  if (!Number.isFinite(end) || end <= start) return 0;
  return end - start;
}

/**
 * @param {Array<{ inputPath: string, trimInSec?: number|null, trimOutSec?: number|null, durationSec?: number }>} items
 * @param {string} outputPath
 * @param {{ gapSeconds?: number, fadeSeconds?: number }} [options]
 * @returns {string[]} ffmpeg argv, not including the binary name
 */
function buildFinalCutConcatArgs(items, outputPath, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("Final cut needs at least one item");
    err.code = "EINVAL";
    throw err;
  }
  if (!outputPath) {
    const err = new Error("Final cut output path is required");
    err.code = "EINVAL";
    throw err;
  }

  const gap = Math.max(0, Number(options.gapSeconds) || 0);
  const fade = Math.max(0, Number(options.fadeSeconds) || 0);
  const args = ["-y", "-hide_banner", "-loglevel", "error"];

  for (const item of items) {
    if (!item || !item.inputPath) {
      const err = new Error("Each final-cut item needs an inputPath");
      err.code = "EINVAL";
      throw err;
    }
    if (item.trimInSec != null && Number(item.trimInSec) > 0) {
      args.push("-ss", formatTime(item.trimInSec));
    }
    if (item.trimOutSec != null && Number.isFinite(Number(item.trimOutSec))) {
      args.push("-to", formatTime(item.trimOutSec));
    }
    args.push("-i", item.inputPath);
  }

  const encode = ["-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath];

  if (items.length === 1 && gap === 0 && fade === 0) {
    return args.concat(encode);
  }

  const n = items.length;
  const filters = [];

  if (fade > 0 && n > 1) {
    let lastV = "[0:v]";
    let lastA = "[0:a]";
    let offset = Math.max(0, itemDurationSec(items[0]) - fade);
    for (let i = 1; i < n; i++) {
      const vOut = i === n - 1 ? "[vout]" : `[vxf${i}]`;
      const aOut = i === n - 1 ? "[aout]" : `[axf${i}]`;
      const gapOff = gap > 0 ? gap : 0;
      filters.push(`${lastV}[${i}:v]xfade=transition=fade:duration=${formatTime(fade)}:offset=${formatTime(offset + gapOff)}${vOut}`);
      filters.push(`${lastA}[${i}:a]acrossfade=d=${formatTime(fade)}${aOut}`);
      lastV = vOut;
      lastA = aOut;
      offset += Math.max(0, itemDurationSec(items[i]) - fade) + gapOff;
    }
    args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]");
    return args.concat(encode);
  }

  const parts = [];
  for (let i = 0; i < n; i++) {
    if (gap > 0 && i < n - 1) {
      filters.push(`[${i}:v]tpad=stop_mode=add:stop_duration=${formatTime(gap)}[vg${i}]`);
      filters.push(`[${i}:a]apad=pad_dur=${formatTime(gap)}[ag${i}]`);
      parts.push(`[vg${i}][ag${i}]`);
    } else {
      parts.push(`[${i}:v][${i}:a]`);
    }
  }
  filters.push(`${parts.join("")}concat=n=${n}:v=1:a=1[vout][aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]");
  return args.concat(encode);
}

function estimateFinalDurationSeconds(items, options = {}) {
  const gap = Math.max(0, Number(options.gapSeconds) || 0);
  const fade = Math.max(0, Number(options.fadeSeconds) || 0);
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += itemDurationSec(items[i]);
    if (i < items.length - 1) {
      if (fade > 0) total += gap - fade;
      else total += gap;
    }
  }
  return Math.max(0, Math.round(total * 10) / 10);
}

module.exports = {
  buildFinalCutConcatArgs,
  estimateFinalDurationSeconds,
  itemDurationSec,
  formatTime,
};
