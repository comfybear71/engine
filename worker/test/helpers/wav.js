"use strict";

/** Writes a minimal, valid silent PCM WAV file -- just enough for ffprobe
 * to report a real duration, with no external dependencies. */

const fs = require("fs");
const path = require("path");

function writeSilentWav(filePath, durationSeconds, sampleRate = 44100) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const numSamples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  // Remaining bytes are already zero (silence).

  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { writeSilentWav };
