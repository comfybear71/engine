"use strict";

/**
 * Build a 44-byte RIFF/WAV header for headerless PCM from ElevenLabs
 * (`output_format=pcm_<rate>`: 16-bit little-endian mono).
 */

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;

function buildWavHeader(
  dataSize,
  { sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS, bitsPerSample = DEFAULT_BITS_PER_SAMPLE } = {}
) {
  if (!Number.isInteger(dataSize) || dataSize < 0) {
    throw new Error(`WAV data size must be a non-negative integer, got ${dataSize}`);
  }
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return header;
}

function pcmToWav(pcmBuffer, options) {
  if (!Buffer.isBuffer(pcmBuffer)) {
    throw new Error("pcmToWav expects a Buffer of raw PCM samples");
  }
  return Buffer.concat([buildWavHeader(pcmBuffer.length, options), pcmBuffer]);
}

module.exports = {
  buildWavHeader,
  pcmToWav,
  WAV_HEADER_BYTES,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_CHANNELS,
  DEFAULT_BITS_PER_SAMPLE,
};
