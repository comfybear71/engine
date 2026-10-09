"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWavHeader,
  pcmToWav,
  WAV_HEADER_BYTES,
  DEFAULT_SAMPLE_RATE,
} = require("../src/voices/wavHeader");

describe("WAV header helper", () => {
  test("writes a 44-byte RIFF/WAV header for 16-bit mono 44100 Hz PCM", () => {
    const dataSize = 88200; // 1 second of 16-bit mono @ 44100
    const header = buildWavHeader(dataSize);

    assert.equal(header.length, WAV_HEADER_BYTES);
    assert.equal(header.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(header.readUInt32LE(4), 36 + dataSize);
    assert.equal(header.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(header.subarray(12, 16).toString("ascii"), "fmt ");
    assert.equal(header.readUInt32LE(16), 16);
    assert.equal(header.readUInt16LE(20), 1); // PCM
    assert.equal(header.readUInt16LE(22), 1); // mono
    assert.equal(header.readUInt32LE(24), DEFAULT_SAMPLE_RATE);
    assert.equal(header.readUInt32LE(28), DEFAULT_SAMPLE_RATE * 2); // byte rate
    assert.equal(header.readUInt16LE(32), 2); // block align
    assert.equal(header.readUInt16LE(34), 16); // bits
    assert.equal(header.subarray(36, 40).toString("ascii"), "data");
    assert.equal(header.readUInt32LE(40), dataSize);
  });

  test("pcmToWav prepends that header to raw PCM", () => {
    const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const wav = pcmToWav(pcm);
    assert.equal(wav.length, WAV_HEADER_BYTES + pcm.length);
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.deepEqual(wav.subarray(WAV_HEADER_BYTES), pcm);
  });
});
