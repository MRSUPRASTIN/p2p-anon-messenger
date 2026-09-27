'use strict';
/**
 * Generates build/icon.ico and build/icon.png from pure code.
 * No native deps: hand-rolled rasteriser -> PNG (zlib) -> ICO container.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ PNG --- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
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

function encodePNG(width, height, rgba) {
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const row = y * stride;
    raw[o] = 4; // Paeth
    for (let x = 0; x < stride; x++) {
      const cur = rgba[row + x];
      const left = x >= bpp ? rgba[row + x - bpp] : 0;
      const up = y > 0 ? rgba[row - stride + x] : 0;
      const ul = y > 0 && x >= bpp ? rgba[row - stride + x - bpp] : 0;
      const v = cur - paeth(left, up, ul);
      raw[o + 1 + x] = v & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- Raster --- */
class Surface {
  constructor(size) {
    this.size = size;
    this.rgb = new Float32Array(size * size * 3);
    this.a = new Float32Array(size * size);
  }
  blend(x, y, r, g, b, a) {
    if (a <= 0) return;
    const i = y * this.size + x;
    const da = this.a[i];
    const na = a + da * (1 - a);
    if (na <= 0) return;
    const k = i * 3;
    const w = da * (1 - a);
    this.rgb[k] = (r * a + this.rgb[k] * w) / na;
    this.rgb[k + 1] = (g * a + this.rgb[k + 1] * w) / na;
    this.rgb[k + 2] = (b * a + this.rgb[k + 2] * w) / na;
    this.a[i] = na;
  }
  toRGBA() {
    const n = this.size * this.size;
    const out = Buffer.alloc(n * 4);
    const q = (v) => Math.round(Math.min(255, Math.max(0, v)));
    for (let i = 0; i < n; i++) {
      out[i * 4] = q(this.rgb[i * 3]);
      out[i * 4 + 1] = q(this.rgb[i * 3 + 1]);
      out[i * 4 + 2] = q(this.rgb[i * 3 + 2]);
      out[i * 4 + 3] = q(this.a[i] * 255);
    }
    return out;
  }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mixc = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}
function sdTriangle(px, py, p0, p1, p2) {
  const e0 = [p1[0] - p0[0], p1[1] - p0[1]];
  const e1 = [p2[0] - p1[0], p2[1] - p1[1]];
  const e2 = [p0[0] - p2[0], p0[1] - p2[1]];
  const v0 = [px - p0[0], py - p0[1]];
  const v1 = [px - p1[0], py - p1[1]];
  const v2 = [px - p2[0], py - p2[1]];
  const proj = (v, e) => {
    const t = clamp((v[0] * e[0] + v[1] * e[1]) / (e[0] * e[0] + e[1] * e[1]), 0, 1);
    return Math.hypot(v[0] - e[0] * t, v[1] - e[1] * t);
  };
  const d = Math.min(proj(v0, e0), proj(v1, e1), proj(v2, e2));
  // orientation-agnostic inside test: all three edge crosses share a sign
  const c0 = e0[0] * v0[1] - e0[1] * v0[0];
  const c1 = e1[0] * v1[1] - e1[1] * v1[0];
  const c2 = e2[0] * v2[1] - e2[1] * v2[0];
  const inside = c0 <= 0 && c1 <= 0 && c2 <= 0 ? true : c0 >= 0 && c1 >= 0 && c2 >= 0;
  return inside ? -d : d;
}
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

/**
 * Fill a shape described by an SDF, 4x4 supersampled.
 * paint(x, y) -> [r, g, b, alpha]; alpha is accumulated per subsample, so a
 * shape can fade out softly (used for the drop shadow and gloss).
 */
function fill(surf, sdf, paint, opts = {}) {
  const N = surf.size;
  const SS = opts.ss || 4;
  const feather = opts.feather != null ? opts.feather : 0.7;
  const step = 1 / SS;
  const off = step * 0.5;
  const inv = 1 / (SS * SS);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + off + sx * step;
          const py = y + off + sy * step;
          const d = sdf(px, py);
          if (d >= feather) continue;
          const c = paint(px, py);
          if (!c) continue;
          const w = Math.max(0, Math.min(1, c[3]));
          if (w <= 0) continue;
          sumA += w;
          sumR += c[0] * w;
          sumG += c[1] * w;
          sumB += c[2] * w;
        }
      }
      if (sumA <= 0) continue;
      const a = Math.min(1, sumA * inv);
      surf.blend(x, y, sumR / sumA, sumG / sumA, sumB / sumA, a);
    }
  }
}

/* ------------------------------------------------------------ Artwork --- */
const C_A = hex('#6366F1');
const C_B = hex('#A855F7');
const C_C = hex('#EC4899');
const WHITE = [255, 255, 255];

function drawIcon(size) {
  const s = new Surface(size);
  const u = size / 512; // design units -> pixels
  const P = (v) => v * u;
  const smoothstep = (e0, e1, v) => {
    const t = clamp((v - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // --- geometry ----------------------------------------------------------
  const bodySdf = (x, y) => sdRoundRect(x, y, P(256), P(256), P(232), P(232), P(104));
  const gradient = (x, y) => {
    const t = clamp((x + y) / (2 * size), 0, 1);
    return t < 0.5 ? mixc(C_A, C_B, t * 2) : mixc(C_B, C_C, (t - 0.5) * 2);
  };

  // --- soft drop shadow (only outside the body, fades with distance) -----
  const blur = P(26);
  const shadowSdf = (x, y) => bodySdf(x, y - P(8));
  fill(s, shadowSdf, (x, y) => {
    const d = shadowSdf(x, y);
    const a = 0.42 * (1 - smoothstep(-P(2), blur, d));
    if (a <= 0.002) return null;
    return [8, 5, 26, a];
  });

  // --- squircle body with gradient --------------------------------------
  fill(s, bodySdf, (x, y) => {
    const c = gradient(x, y);
    const d = Math.hypot(x - P(120), y - P(96)) / P(340);
    const light = clamp(1 - d, 0, 1);
    const lit = mixc(c, [255, 255, 255], light * light * 0.34);
    const d2 = Math.hypot(x - P(430), y - P(450)) / P(360);
    return [lit[0], lit[1], lit[2], 1];
  });

  // --- inner rim light ---------------------------------------------------
  const rimSdf = (x, y) => Math.abs(bodySdf(x, y) + P(3)) - P(2.4);
  fill(s, rimSdf, (x, y) => {
    const a = 0.26 * (1 - smoothstep(0, P(10), rimSdf(x, y)));
    return a <= 0.002 ? null : [255, 255, 255, a];
  });

  // --- chat bubble -------------------------------------------------------
  const bx = P(256);
  const by = P(246);
  const bhw = P(132);
  const bhh = P(104);
  const br = P(46);
  const tail = [
    [P(152), P(320)],
    [P(126), P(410)],
    [P(240), P(340)],
  ];
  const bubbleSdf = (x, y) =>
    smin(sdRoundRect(x, y, bx, by, bhw, bhh, br), sdTriangle(x, y, tail[0], tail[1], tail[2]), P(10));

  // bubble shadow
  const bShadow = (x, y) => bubbleSdf(x, y - P(7));
  fill(s, bShadow, (x, y) => {
    const a = 0.3 * (1 - smoothstep(-P(2), P(18), bShadow(x, y)));
    return a <= 0.002 ? null : [56, 20, 108, a];
  });
  // bubble body
  fill(s, bubbleSdf, (x, y) => {
    const t = clamp((y - P(140)) / P(230), 0, 1);
    const c = mixc([255, 255, 255], [231, 232, 255], t * 0.85);
    return [c[0], c[1], c[2], 1];
  });
  // bubble inner edge
  const bRim = (x, y) => Math.abs(bubbleSdf(x, y) + P(2.6)) - P(2);
  fill(s, bRim, (x, y) => {
    const a = 0.22 * (1 - smoothstep(0, P(8), bRim(x, y)));
    return a <= 0.002 ? null : [124, 92, 224, a];
  });

  // --- smile (lower half of a ring) --------------------------------------
  const scx = P(256);
  const scy = P(266);
  const sr = P(56);
  const sw = P(14);
  const smileSdf = (x, y) =>
    Math.max(Math.abs(Math.hypot(x - scx, y - scy) - sr) - sw, scy - y + P(4));
  fill(s, smileSdf, (x, y) => {
    const c = gradient(x, y);
    return [c[0], c[1], c[2], 1];
  });

  // --- glossy sheen across the bubble top --------------------------------
  const sheenSdf = (x, y) => sdRoundRect(x, y, bx, P(206), P(104), P(40), P(36));
  fill(s, sheenSdf, (x, y) => {
    const a = 0.5 * (1 - smoothstep(-P(30), P(8), sheenSdf(x, y)));
    return a <= 0.002 ? null : [255, 255, 255, a];
  });

  return s;
}

/* ---------------------------------------------------------------- ICO --- */
function buildICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

function main() {
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const cache = new Map();
  const pngFor = (size) => {
    if (!cache.has(size)) {
      const surf = size <= 32 ? drawIcon(size * 2) : drawIcon(size);
      if (size <= 32) {
        // downsample 2x with box filter for crisp small sizes
        const small = new Surface(size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                const i = (y * 2 + dy) * surf.size + (x * 2 + dx);
                const al = surf.a[i];
                r += surf.rgb[i * 3] * al;
                g += surf.rgb[i * 3 + 1] * al;
                b += surf.rgb[i * 3 + 2] * al;
                a += al;
              }
            }
            if (a > 0) small.blend(x, y, r / a, g / a, b / a, a / 4);
          }
        }
        cache.set(size, encodePNG(size, size, small.toRGBA()));
      } else {
        cache.set(size, encodePNG(surf.size, surf.size, surf.toRGBA()));
      }
    }
    return cache.get(size);
  };

  const ico = buildICO(sizes.map((size) => ({ size, data: pngFor(size) })));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

  const big = drawIcon(512);
  fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(512, 512, big.toRGBA()));

  console.log('icon.ico  ' + ico.length + ' bytes  sizes=' + sizes.join(','));
  console.log('icon.png  512x512');
}

module.exports = { drawIcon, encodePNG, buildICO, Surface };

if (require.main === module) main();
