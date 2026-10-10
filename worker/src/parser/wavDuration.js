"use strict";

/**
 * Duration from a RIFF/WAVE header. Reads chunk headers only -- no
 * ffprobe spawn. Returns null when the file is not a readable WAV.
 */

const fs = require("fs");

function readWavDurationSeconds(absPath) {
  const fd = fs.openSync(absPath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 12) return null;
    const riff = Buffer.alloc(12);
    fs.readSync(fd, riff, 0, 12, 0);
    if (riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE") {
      return null;
    }

    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bitsPerSample = 0;
    let byteRate = 0;
    let dataSize = 0;
    const chunkHead = Buffer.alloc(8);

    while (offset + 8 <= fileSize) {
      fs.readSync(fd, chunkHead, 0, 8, offset);
      const id = chunkHead.toString("ascii", 0, 4);
      const size = chunkHead.readUInt32LE(4);
      if (size < 0) return null;
      const payload = offset + 8;
      if (id === "fmt " && size >= 16) {
        const fmt = Buffer.alloc(16);
        fs.readSync(fd, fmt, 0, 16, payload);
        channels = fmt.readUInt16LE(2);
        sampleRate = fmt.readUInt32LE(4);
        byteRate = fmt.readUInt32LE(8);
        bitsPerSample = fmt.readUInt16LE(14);
      } else if (id === "data") {
        dataSize = size;
        break;
      }
      offset = payload + size + (size % 2);
    }

    if (dataSize > 0 && sampleRate > 0 && channels > 0 && bitsPerSample > 0) {
      const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
      if (bytesPerSecond > 0) return dataSize / bytesPerSecond;
    }
    if (dataSize > 0 && byteRate > 0) return dataSize / byteRate;
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readWavDurationSeconds };
