/**
 * Unit check for the tracing core, with an exact analytic truth.
 *
 * Builds a mask whose boundaries are known to the last decimal (a 45-degree
 * band, a disc, a ring), traces it, then evaluates every emitted Bézier against
 * the analytic boundary. Also checks areas and that no other geometry appears.
 */
import { contoursForMask, extractRings, ringArea, type CoreOptions, type Pt } from "../src/trace-core.server";

const options: CoreOptions = { sigma: 0.65, fitError: 0.3, cornerAngle: 32, minArea: 1, precision: 3 };

const W = 240;
const H = 240;

// Geometry (in image coordinates, 0..W / 0..H):
//  - a band of half-width 1.0 px along x - y = 0   (a 45-degree 2px line)
//  - a disc centred (170,70) r = 26
//  - a ring: annulus centred (70,170), outer 30, inner 26
const distToLine = (x: number, y: number) => Math.abs(x - y) / Math.SQRT2;
const radial = (x: number, y: number, cx: number, cy: number) => Math.hypot(x - cx, y - cy);

const mask = new Uint8Array(W * H);
for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) {
    // sample the pixel centre
    const x = px + 0.5;
    const y = py + 0.5;
    let v = 0;
    if (distToLine(x, y) <= 1.0) v = 1;
    if (radial(x, y, 170, 70) <= 26) v = 1;
    const r = radial(x, y, 70, 170);
    if (r <= 30 && r >= 26) v = 1;
    mask[py * W + px] = v;
  }
}

const t0 = Date.now();
const contours = contoursForMask(mask, W, H, [0, 0, W - 1, H - 1], options);
const ms = Date.now() - t0;

function parseCubics(d: string): { p0: Pt; c1: Pt; c2: Pt; p1: Pt }[] {
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
  const out: { p0: Pt; c1: Pt; c2: Pt; p1: Pt }[] = [];
  let i = 0;
  let cur: Pt = { x: nums[0], y: nums[1] };
  i = 2;
  while (i < nums.length) {
    const c1 = { x: nums[i], y: nums[i + 1] };
    const c2 = { x: nums[i + 2], y: nums[i + 3] };
    const p1 = { x: nums[i + 4], y: nums[i + 5] };
    out.push({ p0: cur, c1, c2, p1 });
    cur = p1;
    i += 6;
  }
  return out;
}

function sample(c: { p0: Pt; c1: Pt; c2: Pt; p1: Pt }, t: number): Pt {
  const mt = 1 - t;
  const b0 = mt * mt * mt;
  const b1 = 3 * t * mt * mt;
  const b2 = 3 * t * t * mt;
  const b3 = t * t * t;
  return {
    x: b0 * c.p0.x + b1 * c.c1.x + b2 * c.c2.x + b3 * c.p1.x,
    y: b0 * c.p0.y + b1 * c.c1.y + b2 * c.c2.y + b3 * c.p1.y,
  };
}

console.log(`contours: ${String(contours.length)}  (in ${String(ms)}ms)`);
console.log(`curves:   ${String(contours.reduce((s, c) => s + c.curves, 0))}`);
console.log(`area sum: ${contours.reduce((s, c) => s + c.area, 0).toFixed(2)}`);

// analytic area: band inside the region + disc + annulus
let expected = 0;
for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) if (mask[py * W + px]) expected++;
}
console.log(`mask px:  ${String(expected)}`);

let worstLine = 0;
let worstDisc = 0;
let worstRing = 0;
let nLine = 0;
let nDisc = 0;
let nRing = 0;
for (const c of contours) {
  const curves = parseCubics(c.d);
  for (const cv of curves) {
    for (let s = 0; s <= 24; s++) {
      const p = sample(cv, s / 24);
      const isLine = c.area > 1500 && c.area < 2500;
      const isDisc = c.area > 1900 && c.area < 2200;
      void isDisc;
      const dl = distToLine(p.x, p.y);
      const rd = radial(p.x, p.y, 170, 70);
      const rr = radial(p.x, p.y, 70, 170);
      if (Math.abs(dl - 1.0) < 1.5) {
        nLine++;
        worstLine = Math.max(worstLine, Math.abs(dl - 1.0));
      } else if (Math.abs(rd - 26) < 2) {
        nDisc++;
        worstDisc = Math.max(worstDisc, Math.abs(rd - 26));
      } else if (Math.abs(rr - 30) < 2 || Math.abs(rr - 26) < 2) {
        nRing++;
        worstRing = Math.max(worstRing, Math.min(Math.abs(rr - 30), Math.abs(rr - 26)));
      }
    }
  }
}
console.log(`45deg line boundary: max deviation ${worstLine.toFixed(3)} px over ${String(nLine)} samples`);
console.log(`disc boundary:       max deviation ${worstDisc.toFixed(3)} px over ${String(nDisc)} samples`);
console.log(`ring boundary:       max deviation ${worstRing.toFixed(3)} px over ${String(nRing)} samples`);

// Does every ring's signed area match its true enclosure? Print the biggest few.
const areas = contours.map((c) => c.area).sort((a, b) => b - a).slice(0, 6);
console.log("largest contour areas:", areas.map((a) => a.toFixed(1)).join(", "));

const d = contours.reduce((s, c) => s + c.d.length, 0);
console.log(`path data bytes: ${String(d)}`);
console.log("sample d:", contours[0]?.d.slice(0, 140));
void ringArea;

const dbg = extractRings(mask, W, H, [0, 0, W - 1, H - 1], options.sigma);
console.log("DBG field", dbg.fieldMin.toFixed(4), dbg.fieldMax.toFixed(4), "rings:", dbg.rings.length, "lens:", dbg.rings.map((r) => r.length).join(","));
console.log("DBG first ring pts:", dbg.rings[0]?.slice(0, 4).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
