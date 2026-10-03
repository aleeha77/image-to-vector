/**
 * Tuning grid for the tracing core, measured against an analytic truth.
 *
 * The mask is the rasterisation of three known shapes (a 2px 45-degree band, a
 * disc, an annulus). Every emitted Bézier is then sampled and its distance to the
 * *nearest* analytic boundary is measured, both absolutely and (for the band,
 * away from the canvas edge) in terms of straightness. That isolates:
 *   - accuracy  (mean/max distance to the true outline),
 *   - ripple    (how much the outline waves around the truth),
 *   - economy   (curves emitted per unit of outline).
 */
import { contoursForMask, type CoreOptions, type Pt } from "../src/trace-core.server";

const W = 240;
const H = 240;
const BAND_HALF = 1.0; // true half-width of the 45-degree band, in px
const DISC = { x: 170, y: 70, r: 26 };
const RING = { x: 70, y: 170, oc: 30, ic: 26 };

const mask = new Uint8Array(W * H);
for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) {
    const x = px + 0.5;
    const y = py + 0.5;
    let v = 0;
    if (Math.abs(x - y) / Math.SQRT2 <= BAND_HALF) v = 1;
    if (Math.hypot(x - DISC.x, y - DISC.y) <= DISC.r) v = 1;
    const r = Math.hypot(x - RING.x, y - RING.y);
    if (r <= RING.oc && r >= RING.ic) v = 1;
    mask[py * W + px] = v;
  }
}

function parseCubics(d: string) {
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
  const out: { c1: Pt; c2: Pt; p1: Pt }[] = [];
  let cur = { x: nums[0], y: nums[1] };
  for (let i = 2; i + 5 < nums.length + 1; i += 6) {
    const p1 = { x: nums[i + 4], y: nums[i + 5] };
    out.push({ c1: { x: nums[i], y: nums[i + 1] }, c2: { x: nums[i + 2], y: nums[i + 3] }, p1 });
    cur = p1;
  }
  void cur;
  return out;
}

function sample(prev: Pt, c: { c1: Pt; c2: Pt; p1: Pt }, t: number): Pt {
  const mt = 1 - t;
  const b0 = mt * mt * mt;
  const b1 = 3 * t * mt * mt;
  const b2 = 3 * t * t * mt;
  const b3 = t * t * t;
  return {
    x: b0 * prev.x + b1 * c.c1.x + b2 * c.c2.x + b3 * c.p1.x,
    y: b0 * prev.y + b1 * c.c1.y + b2 * c.c2.y + b3 * c.p1.y,
  };
}

/** Distance from a point to the nearest of the analytic boundaries. */
function deviation(p: Pt): number {
  const dBand = Math.abs(Math.abs(p.x - p.y) / Math.SQRT2 - BAND_HALF);
  const dDisc = Math.abs(Math.hypot(p.x - DISC.x, p.y - DISC.y) - DISC.r);
  const r = Math.hypot(p.x - RING.x, p.y - RING.y);
  const dRing = Math.min(Math.abs(r - RING.oc), Math.abs(r - RING.ic));
  // canvas edges are real boundaries too where a shape runs off the canvas
  const dEdge = Math.min(p.x, p.y, W - p.x, H - p.y);
  return Math.min(dBand, dDisc, dRing, dEdge);
}

function run(o: CoreOptions) {
  const t0 = Date.now();
  const contours = contoursForMask(mask, W, H, [0, 0, W - 1, H - 1], o);
  const ms = Date.now() - t0;
  let curves = 0;
  const devs: number[] = [];
  let perimeter = 0;
  for (const c of contours) {
    const cs = parseCubics(c.d);
    curves += cs.length;
    let prev = { x: 0, y: 0 };
    const m = c.d.match(/^M(-?[\d.]+) (-?[\d.]+)/);
    if (m) prev = { x: Number(m[1]), y: Number(m[2]) };
    for (const cv of cs) {
      let last = prev;
      for (let s = 1; s <= 12; s++) {
        const p = sample(prev, cv, s / 12);
        if (Math.abs(p.x) > 1e-6 || Math.abs(p.y) > 1e-6) devs.push(deviation(p));
        perimeter += Math.hypot(p.x - last.x, p.y - last.y);
        last = p;
      }
      prev = cv.p1;
    }
  }
  devs.sort((a, b) => a - b);
  const mean = devs.reduce((s, d) => s + d, 0) / Math.max(1, devs.length);
  return {
    contours: contours.length,
    curves,
    mean: mean.toFixed(3),
    p95: devs[Math.floor(devs.length * 0.95)]?.toFixed(3),
    max: devs[devs.length - 1]?.toFixed(3),
    per100px: ((curves / perimeter) * 100).toFixed(1),
    ms,
  };
}

console.log("sigma  err  contours curves  mean   p95    max   curves/100px  ms");
for (const sigma of [0.5, 0.65, 0.9, 1.2, 1.6]) {
  for (const fitError of [0.2, 0.35, 0.6]) {
    const r = run({ sigma, fitError, cornerAngle: 32, minArea: 1, precision: 3 });
    console.log(
      `${sigma.toFixed(2)}   ${fitError.toFixed(2)}  ${String(r.contours).padStart(2)}      ${String(r.curves).padStart(4)}    ${r.mean}  ${r.p95}  ${r.max}    ${r.per100px.padStart(6)}     ${r.ms}`,
    );
  }
}
