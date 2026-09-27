'use strict';
/** Sanity checks for the generated icon: geometry, alpha, palette. */
const { drawIcon } = require('./make-icon.js');

function at(s, fx, fy) {
  const x = Math.round(fx * (s.size - 1));
  const y = Math.round(fy * (s.size - 1));
  const i = y * s.size + x;
  return {
    r: Math.round(s.rgb[i * 3]),
    g: Math.round(s.rgb[i * 3 + 1]),
    b: Math.round(s.rgb[i * 3 + 2]),
    a: +(s.a[i].toFixed(3)),
  };
}

const s = drawIcon(256);
const pts = {
  'corner (0,0)': at(s, 0, 0),
  'corner (1,1)': at(s, 1, 1),
  'top edge (0.5,0.005)': at(s, 0.5, 0.005),
  'squircle TL (0.2,0.2)': at(s, 0.2, 0.2),
  'squircle BR (0.8,0.8)': at(s, 0.8, 0.8),
  'bubble centre (0.5,0.42)': at(s, 0.5, 0.42),
  'smile stroke (0.5,0.605)': at(s, 0.5, 0.605),
  'tail tip (0.25,0.795)': at(s, 0.25, 0.795),
  'outside bubble (0.16,0.45)': at(s, 0.16, 0.45),
  'below squircle (0.5,0.99)': at(s, 0.5, 0.99),
};
console.log(pts);

// coverage / sanity
let opaque = 0;
let transparent = 0;
let white = 0;
for (let i = 0; i < s.a.length; i++) {
  if (s.a[i] > 0.95) opaque++;
  if (s.a[i] < 0.05) transparent++;
  if (s.a[i] > 0.9 && s.rgb[i * 3] > 0.9 && s.rgb[i * 3 + 1] > 0.9 && s.rgb[i * 3 + 2] > 0.9) white++;
}
console.log({ opaquePct: ((opaque / s.a.length) * 100).toFixed(1), transparentPct: ((transparent / s.a.length) * 100).toFixed(1), whitePct: ((white / s.a.length) * 100).toFixed(1) });

// alpha must be monotonic-ish: no NaN
let nan = 0;
for (let i = 0; i < s.a.length; i++) if (!Number.isFinite(s.a[i]) || !Number.isFinite(s.rgb[i * 3])) nan++;
console.log({ nan });
