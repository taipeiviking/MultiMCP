// Generates tray/app icons (amber dot on transparent) as PNGs — no native deps.
// Run: node electron/assets/make-icon.js  -> writes tray.png (32) and icon.png (256).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// CRC32 for PNG chunks.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size * 0.46; // dot radius
  const amber = [0xf5, 0xa6, 0x23];
  const dark = [0x0e, 0x11, 0x16];

  // RGBA raw with one filter byte (0) per row.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  const SS = 4; // supersample for anti-aliasing
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const d = Math.hypot(px - cx - 0.5, py - cy - 0.5);
          if (d <= rOuter) inside++;
        }
      }
      const cov = inside / (SS * SS);
      const o = y * (stride + 1) + 1 + x * 4;
      // subtle dark ring for contrast on light trays
      const ring = Math.max(0, Math.min(1, (rOuter - Math.hypot(x - cx, y - cy)) / 1.5));
      const col = amber;
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
      raw[o + 3] = Math.round(cov * 255);
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = __dirname;
fs.writeFileSync(path.join(dir, "tray.png"), makePng(32));
fs.writeFileSync(path.join(dir, "tray@2x.png"), makePng(64));
fs.writeFileSync(path.join(dir, "icon.png"), makePng(256));
console.log("Wrote tray.png (32), tray@2x.png (64), icon.png (256) to", dir);
