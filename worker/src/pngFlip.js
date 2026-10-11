"use strict";

/**
 * Horizontal flip for 8-bit PNGs (the cut-out sheets Studio writes).
 * No extra image library — Node zlib only.
 */

const zlib = require("zlib");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function bytesPerPixel(colorType, bitDepth) {
  if (bitDepth !== 8) return 0;
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 3) return 1;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

function readChunks(buf) {
  if (!buf || buf.length < 8 || !PNG_SIG.equals(buf.subarray(0, 8))) {
    throw new Error("Not a PNG");
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data: Buffer.from(data) });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const sample = raw[src + x];
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev[x];
      const upLeft = x >= bpp ? prev[x - bpp] : 0;
      let recon = sample;
      if (filter === 1) recon = (sample + left) & 255;
      else if (filter === 2) recon = (sample + up) & 255;
      else if (filter === 3) recon = (sample + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) recon = (sample + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      row[x] = recon;
    }
    row.copy(out, y * stride);
    prev = row;
    src += stride;
  }
  return out;
}

function flipPixels(pixels, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(pixels.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const src = row + x * bpp;
      const dest = row + (width - 1 - x) * bpp;
      pixels.copy(out, dest, src, src + bpp);
    }
  }
  return out;
}

function encodeFiltered(pixels, width, height, bpp) {
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return zlib.deflateSync(raw);
}

function encodePng(width, height, colorType, pixels, extras = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const bpp = bytesPerPixel(colorType, 8);
  const idat = encodeFiltered(pixels, width, height, bpp);
  const parts = [PNG_SIG, chunk("IHDR", ihdr)];
  for (const extra of extras) parts.push(chunk(extra.type, extra.data));
  parts.push(chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function encodeRgbaPng(width, height, rgba) {
  return encodePng(width, height, 6, rgba);
}

function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((item) => item.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) throw new Error("PNG is missing IHDR");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (interlace !== 0) throw new Error("Interlaced PNGs cannot be flipped here");
  const bpp = bytesPerPixel(colorType, bitDepth);
  if (!bpp) throw new Error("Only 8-bit PNG color types 0/2/3/4/6 can be flipped");
  const idat = Buffer.concat(chunks.filter((item) => item.type === "IDAT").map((item) => item.data));
  const raw = zlib.inflateSync(idat);
  const pixels = unfilter(raw, width, height, bpp);
  const extras = chunks.filter((item) => item.type === "PLTE" || item.type === "tRNS");
  return { width, height, colorType, bpp, pixels, extras };
}

function flipPngHorizontal(buf) {
  const decoded = decodePng(buf);
  const flipped = flipPixels(decoded.pixels, decoded.width, decoded.height, decoded.bpp);
  return encodePng(decoded.width, decoded.height, decoded.colorType, flipped, decoded.extras);
}

module.exports = {
  flipPngHorizontal,
  encodeRgbaPng,
  decodePng,
};
