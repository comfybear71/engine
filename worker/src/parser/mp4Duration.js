"use strict";

/**
 * Duration from an MP4/MOV movie header (moov/mvhd), used when ffprobe
 * is missing or fails. Reads box headers only -- does not load the file.
 */

const fs = require("fs");

function readBoxAt(fd, offset, fileSize) {
  if (offset + 8 > fileSize) return null;
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 8, offset);
  let size = header.readUInt32BE(0);
  const type = header.toString("ascii", 4, 8);
  let hdr = 8;
  if (size === 1) {
    if (offset + 16 > fileSize) return null;
    fs.readSync(fd, header, 8, 8, offset + 8);
    const big = header.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    hdr = 16;
  } else if (size === 0) {
    size = fileSize - offset;
  }
  if (size < hdr || offset + size > fileSize) return null;
  return { type, hdr, size, payload: offset + hdr, end: offset + size };
}

function findBox(fd, start, end, fileSize, wanted) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxAt(fd, offset, fileSize);
    if (!box || box.end > end) return null;
    if (box.type === wanted) return box;
    offset = box.end;
  }
  return null;
}

function readMp4DurationSeconds(absPath) {
  const fd = fs.openSync(absPath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const moov = findBox(fd, 0, fileSize, fileSize, "moov");
    if (!moov) return null;
    const mvhd = findBox(fd, moov.payload, moov.end, fileSize, "mvhd");
    if (!mvhd) return null;
    const buf = Buffer.alloc(Math.min(mvhd.size - mvhd.hdr, 32));
    if (buf.length < 20) return null;
    fs.readSync(fd, buf, 0, buf.length, mvhd.payload);
    const version = buf[0];
    let timescale;
    let duration;
    if (version === 1) {
      if (buf.length < 32) return null;
      timescale = buf.readUInt32BE(20);
      const dur = buf.readBigUInt64BE(24);
      duration = Number(dur);
    } else {
      timescale = buf.readUInt32BE(12);
      duration = buf.readUInt32BE(16);
    }
    if (!timescale || !Number.isFinite(duration) || duration <= 0) return null;
    return duration / timescale;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readMp4DurationSeconds };
