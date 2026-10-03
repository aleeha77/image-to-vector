/**
 * Tracecraft tracing core — raster -> vector geometry, sub-pixel.
 *
 * Why this exists (the defect it fixes): tracing pixel *boundaries* quantises
 * every contour to the source raster's grid and registers it half a pixel off,
 * so a 45-degree edge becomes a staircase and a hairline fragments. This core
 * instead:
 *
 *  1. takes a *coverage field* per colour/ink region (the region mask, smoothed
 *     with a small Gaussian) instead of the mask itself, so the region boundary
 *     is a continuous level set rather than a pixel edge;
 *  2. extracts that level set (iso 0.5) with marching squares and *linear
 *     interpolation* between neighbouring field samples — so contour vertices land
 *     at arbitrary sub-pixel coordinates, in the same coordinate system the raster
 *     occupies ([0,w] x [0,h] with pixel centres at +0.5);
 *  3. detects corners on the contour (turn angle + non-max suppression) and fits
 *     true cubic Béziers between them by least squares (Schneider's algorithm),
 *     so straight edges stay straight and curves stay curves.
 *
 * The output is `<path>` elements made of cubic Béziers only — no `<image>`, no
 * embedded raster, no polyline faceting. Everything is in memory.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface CoreOptions {
  /** Field smoothing in working pixels. ~0.65 keeps 2px features intact. */
  sigma: number;
  /** Max allowed curve-fitting deviation, working pixels. */
  fitError: number;
  /** Turn angle (degrees) above which a contour point counts as a corner. */
  cornerAngle: number;
  /** Contours enclosing less than this (px^2) are dropped as noise. */
  minArea: number;
  /** Decimal places in the emitted path data. */
  precision: number;
}

interface Cubic {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p1: Pt;
}

/* ------------------------------------------------------------------ *
 * Gaussian smoothing of a binary region mask -> coverage field
 * ------------------------------------------------------------------ */

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * Smooth the pixel rectangle [x0..x1] x [y0..y1] (inclusive, may extend past the
 * image) of `mask` into a fresh Float32Array. Samples outside the image read as
 * 0, so a region that runs off the canvas closes exactly at the canvas edge.
 */
function fieldFromMask(
  mask: Uint8Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sigma: number,
): { field: Float32Array; fw: number; fh: number } {
  const fw = x1 - x0 + 1;
  const fh = y1 - y0 + 1;
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(fw * fh);
  const out = new Float32Array(fw * fh);

  for (let fy = 0; fy < fh; fy++) {
    const sy = y0 + fy;
    if (sy < 0 || sy >= h) continue;
    const row = fy * fw;
    for (let fx = 0; fx < fw; fx++) {
      const sx = x0 + fx;
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const px = sx + i;
        if (px < 0 || px >= w) continue;
        acc += k[i + r] * mask[sy * w + px];
      }
      tmp[row + fx] = acc;
    }
  }
  for (let fy = 0; fy < fh; fy++) {
    const sy = y0 + fy;
    for (let fx = 0; fx < fw; fx++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const py = sy + i;
        if (py < 0 || py >= h) continue;
        acc += k[i + r] * tmp[(fy + i) * fw + fx];
      }
      out[fy * fw + fx] = acc;
    }
  }
  return { field: out, fw, fh };
}

/* ------------------------------------------------------------------ *
 * Marching squares on the coverage field
 * ------------------------------------------------------------------ */

const ISO = 0.5;
const KEY_MUL = 1_000_007;

// Grid-edge ids. `i`/`j` are *field* indices (may be -1 or fw), encoded positive.
const HID = (i: number, j: number) => ((i + 2) * 4 + 0) * KEY_MUL + (j + 2);
const VID = (i: number, j: number) => ((i + 2) * 4 + 1) * KEY_MUL + (j + 2);

/**
 * Extract closed ISO-contours with linear interpolation, in *image* coordinates
 * (pixel index + 0.5). Returns one point ring per contour.
 */
function marchingSquares(
  field: Float32Array,
  fw: number,
  fh: number,
  x0: number,
  y0: number,
): Pt[][] {
  const at = (i: number, j: number) =>
    j < 0 || j >= fh || i < 0 || i >= fw ? 0 : field[j * fw + i];

  // Each crossing point is a node; every node joins exactly two cells' segments.
  const succ = new Map<number, number>();

  const crossing = (id: number): Pt => {
    const h = Math.floor(id / KEY_MUL);
    const j = (id % KEY_MUL) - 2;
    const vertical = h % 4 === 1;
    const i = Math.floor(h / 4) - 2;
    if (!vertical) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const t = Math.abs(b - a) < 1e-12 ? 0.5 : (ISO - a) / (b - a);
      return { x: x0 + i + Math.min(1, Math.max(0, t)) + 0.5, y: y0 + j + 0.5 };
    }
    const a = at(i, j);
    const b = at(i, j + 1);
    const t = Math.abs(b - a) < 1e-12 ? 0.5 : (ISO - a) / (b - a);
    return { x: x0 + i + 0.5, y: y0 + j + Math.min(1, Math.max(0, t)) + 0.5 };
  };

  for (let cy = -1; cy < fh; cy++) {
    for (let cx = -1; cx < fw; cx++) {
      const v0 = at(cx, cy); // top-left
      const v1 = at(cx + 1, cy); // top-right
      const v2 = at(cx + 1, cy + 1); // bottom-right
      const v3 = at(cx, cy + 1); // bottom-left
      let idx = 0;
      if (v0 >= ISO) idx |= 8;
      if (v1 >= ISO) idx |= 4;
      if (v2 >= ISO) idx |= 2;
      if (v3 >= ISO) idx |= 1;
      if (idx === 0 || idx === 15) continue;

      const top = HID(cx, cy);
      const bottom = HID(cx, cy + 1);
      const left = VID(cx, cy);
      const right = VID(cx + 1, cy);

      // Direction of every case is derived from the rule "the region (>= ISO) is
      // on a fixed side of travel", which is what makes the segments chain into
      // closed rings. (Getting this wrong fragments contours.)
      switch (idx) {
        case 1:
          succ.set(left, bottom);
          break;
        case 2:
          succ.set(bottom, right);
          break;
        case 3:
          succ.set(left, right);
          break;
        case 4:
          succ.set(right, top);
          break;
        case 6:
          succ.set(bottom, top);
          break;
        case 7:
          succ.set(left, top);
          break;
        case 8:
          succ.set(top, left);
          break;
        case 9:
          succ.set(top, bottom);
          break;
        case 11:
          succ.set(top, right);
          break;
        case 12:
          succ.set(right, left);
          break;
        case 13:
          succ.set(right, bottom);
          break;
        case 14:
          succ.set(bottom, left);
          break;
        case 5: {
          // v1 and v3 inside: connect the inside corners unless the cell is
          // mostly outside, in which case isolate them.
          const mean = (v0 + v1 + v2 + v3) / 4;
          if (mean >= ISO) {
            succ.set(left, top);
            succ.set(right, bottom);
          } else {
            succ.set(right, top);
            succ.set(left, bottom);
          }
          break;
        }
        case 10: {
          const mean = (v0 + v1 + v2 + v3) / 4;
          if (mean >= ISO) {
            succ.set(left, top);
            succ.set(right, bottom);
          } else {
            succ.set(top, left);
            succ.set(bottom, right);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const rings: Pt[][] = [];
  const consumed = new Set<number>();
  const cache = new Map<number, Pt>();
  const point = (id: number): Pt => {
    let p = cache.get(id);
    if (!p) {
      p = crossing(id);
      cache.set(id, p);
    }
    return p;
  };
  const starts = [...succ.keys()];
  let guard = 0;
  for (const start of starts) {
    if (consumed.has(start)) continue;
    const ring: Pt[] = [];
    let id: number | undefined = start;
    while (id !== undefined && !consumed.has(id)) {
      consumed.add(id);
      const nxt = succ.get(id);
      if (nxt === undefined) break;
      ring.push(point(id));
      id = nxt;
      if (++guard > 40_000_000) break;
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/* ------------------------------------------------------------------ *
 * Corner detection
 * ------------------------------------------------------------------ */

function findCorners(pts: Pt[], angleDeg: number, window = 5): number[] {
  const n = pts.length;
  if (n < 2 * window + 2) return [];
  const thresh = (angleDeg * Math.PI) / 180;
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - window + n) % n];
    const b = pts[i];
    const c = pts[(i + window) % n];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1.2 || l2 < 1.2) continue;
    const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
    turn[i] = Math.acos(Math.min(1, Math.max(-1, cos)));
  }
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < thresh) continue;
    let best = true;
    for (let d = -window; d <= window; d++) {
      if (d === 0) continue;
      const j = (i + d + n) % n;
      if (turn[j] > turn[i] || (turn[j] === turn[i] && j < i)) {
        best = false;
        break;
      }
    }
    if (best) corners.push(i);
  }
  corners.sort((a, b) => a - b);
  // Drop corners that are too close together to be separate features: a 2px
  // step on a curve is ripple, not a corner.
  const merged: number[] = [];
  for (const c of corners) {
    const last = merged[merged.length - 1];
    if (last !== undefined && ((c - last) % n < 3 || (n - (c - last)) % n < 3)) continue;
    merged.push(c);
  }
  if (merged.length > 1 && (n - merged[merged.length - 1] + merged[0]) % n < 3) merged.pop();
  return merged;
}

/**
 * Binomial smoothing of the contour's interior, tapered to zero at the knots so
 * detected corners stay sharp. Removes the residual pixel-scale ripple left by
 * the region mask without moving straight edges or corners.
 */
function smoothRing(ring: Pt[], knots: number[], passes = 3): Pt[] {
  const n = ring.length;
  if (!knots.length || n < 12) return ring;
  const dist = new Float64Array(n).fill(Infinity);
  for (const k of knots) {
    for (let i = 0; i < n; i++) {
      const d = Math.min(Math.abs(i - k), n - Math.abs(i - k));
      if (d < dist[i]) dist[i] = d;
    }
  }
  const weight = new Float64Array(n);
  for (let i = 0; i < n; i++) weight[i] = Math.min(1, Math.max(0, (dist[i] - 1.5) / 3));
  let cur = ring;
  for (let pass = 0; pass < passes; pass++) {
    const next: Pt[] = new Array<Pt>(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      const w = weight[i];
      next[i] = {
        x: b.x + w * (0.25 * a.x + 0.5 * b.x + 0.25 * c.x - b.x),
        y: b.y + w * (0.25 * a.y + 0.5 * b.y + 0.25 * c.y - b.y),
      };
    }
    cur = next;
  }
  return cur;
}

/* ------------------------------------------------------------------ *
 * Schneider cubic fitting
 * ------------------------------------------------------------------ */

function chordLengthParameterize(pts: Pt[]): number[] {
  const u: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    u.push(u[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = u[u.length - 1];
  if (total <= 1e-12) return pts.map((_, i) => i / Math.max(1, pts.length - 1));
  return u.map((v) => v / total);
}

function bezAt(c: Cubic, t: number): Pt {
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

/** Least-squares control points for fixed end tangents (Graphics Gems IV). */
function generateBezier(pts: Pt[], u: number[], t1: Pt, t2: Pt): Cubic {
  const n = pts.length;
  const p0 = pts[0];
  const p3 = pts[n - 1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < n; i++) {
    const ui = u[i];
    const mt = 1 - ui;
    const b0 = mt * mt * mt;
    const b1 = 3 * ui * mt * mt;
    const b2 = 3 * ui * ui * mt;
    const b3 = ui * ui * ui;
    const a0x = t1.x * b1;
    const a0y = t1.y * b1;
    const a1x = t2.x * b2;
    const a1y = t2.y * b2;
    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;
    const tmpX = pts[i].x - (p0.x * (b0 + b1) + p3.x * (b2 + b3));
    const tmpY = pts[i].y - (p0.y * (b0 + b1) + p3.y * (b2 + b3));
    x0 += a0x * tmpX + a0y * tmpY;
    x1 += a1x * tmpX + a1y * tmpY;
  }
  const detC0C1 = c00 * c11 - c01 * c01;
  const detC0X = c00 * x1 - c01 * x0;
  const detXC1 = x0 * c11 - x1 * c01;
  const alphaL = Math.abs(detC0C1) < 1e-12 ? 0 : detXC1 / detC0C1;
  const alphaR = Math.abs(detC0C1) < 1e-12 ? 0 : detC0X / detC0C1;
  const segLength = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const epsilon = 1e-6 * segLength;
  if (alphaL < epsilon || alphaR < epsilon) {
    const dist = segLength / 3;
    return {
      p0,
      c1: { x: p0.x + t1.x * dist, y: p0.y + t1.y * dist },
      c2: { x: p3.x + t2.x * dist, y: p3.y + t2.y * dist },
      p1: p3,
    };
  }
  return {
    p0,
    c1: { x: p0.x + t1.x * alphaL, y: p0.y + t1.y * alphaL },
    c2: { x: p3.x + t2.x * alphaR, y: p3.y + t2.y * alphaR },
    p1: p3,
  };
}

function maxError(pts: Pt[], curve: Cubic, u: number[]): { max: number; index: number } {
  let max = 0;
  let index = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = bezAt(curve, u[i]);
    const dx = p.x - pts[i].x;
    const dy = p.y - pts[i].y;
    const d = dx * dx + dy * dy;
    if (d >= max) {
      max = d;
      index = i;
    }
  }
  return { max, index };
}

function reparameterize(pts: Pt[], u: number[], c: Cubic): number[] {
  return u.map((ui, i) => {
    const mt = 1 - ui;
    const b0 = mt * mt * mt;
    const b1 = 3 * ui * mt * mt;
    const b2 = 3 * ui * ui * mt;
    const b3 = ui * ui * ui;
    const d1 = 3 * mt * mt;
    const d2 = 6 * ui * mt;
    const d3 = 3 * ui * ui;
    const qx = b0 * c.p0.x + b1 * c.c1.x + b2 * c.c2.x + b3 * c.p1.x;
    const qy = b0 * c.p0.y + b1 * c.c1.y + b2 * c.c2.y + b3 * c.p1.y;
    const q1x = d1 * (c.c1.x - c.p0.x) + d2 * (c.c2.x - c.c1.x) + d3 * (c.p1.x - c.c2.x);
    const q1y = d1 * (c.c1.y - c.p0.y) + d2 * (c.c2.y - c.c1.y) + d3 * (c.p1.y - c.c2.y);
    const q2x = 6 * mt * (c.c2.x - 2 * c.c1.x + c.p0.x) + 6 * ui * (c.p1.x - 2 * c.c2.x + c.c1.x);
    const q2y = 6 * mt * (c.c2.y - 2 * c.c1.y + c.p0.y) + 6 * ui * (c.p1.y - 2 * c.c2.y + c.c1.y);
    const num = (qx - pts[i].x) * q1x + (qy - pts[i].y) * q1y;
    const den = q1x * q1x + q1y * q1y + (qx - pts[i].x) * q2x + (qy - pts[i].y) * q2y;
    return Math.abs(den) < 1e-12 ? ui : ui - num / den;
  });
}

function unit(v: Pt): Pt {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** Fit a chain of cubic Béziers through an open polyline, within `error` px. */
function fitCubic(pts: Pt[], t1: Pt, t2: Pt, error: number, depth = 0): Cubic[] {
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) {
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / 3;
    return [
      {
        p0: pts[0],
        c1: { x: pts[0].x + t1.x * dist, y: pts[0].y + t1.y * dist },
        c2: { x: pts[1].x + t2.x * dist, y: pts[1].y + t2.y * dist },
        p1: pts[1],
      },
    ];
  }
  let u = chordLengthParameterize(pts);
  let curve = generateBezier(pts, u, t1, t2);
  let { max, index } = maxError(pts, curve, u);
  const errSq = error * error;
  if (max < errSq) return [curve];
  if (max < errSq * 4 && depth < 6) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(pts, u, curve);
      curve = generateBezier(pts, u, t1, t2);
      const r = maxError(pts, curve, u);
      max = r.max;
      index = r.index;
      if (max < errSq) return [curve];
    }
  }
  if (index <= 0) index = 1;
  if (index >= n - 1) index = n - 2;
  const centre = unit({
    x: (pts[index - 1].x - pts[index + 1].x) / 2,
    y: (pts[index - 1].y - pts[index + 1].y) / 2,
  });
  const left = fitCubic(pts.slice(0, index + 1), t1, centre, error, depth + 1);
  const right = fitCubic(pts.slice(index), { x: -centre.x, y: -centre.y }, t2, error, depth + 1);
  return left.concat(right);
}

/* ------------------------------------------------------------------ *
 * Contour -> path data
 * ------------------------------------------------------------------ */

export function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  }
  return a / 2;
}

function evenSplit(n: number): number[] {
  const chunks = Math.max(2, Math.min(n, Math.ceil(n / 120)));
  const knots: number[] = [];
  for (let i = 0; i < chunks; i++) knots.push(Math.round((i * n) / chunks));
  return knots;
}

/** Fit one closed contour; corners split it into tangent-continuous arcs. */
function fitRing(ring: Pt[], o: CoreOptions): Cubic[] {
  const n = ring.length;
  if (n < 4) return [];
  const corners = findCorners(ring, o.cornerAngle, 5);
  const knots: number[] = corners.length ? corners : evenSplit(n);
  const smooth = smoothRing(ring, knots);
  const out: Cubic[] = [];
  for (let k = 0; k < knots.length; k++) {
    const a = knots[k];
    const b = k + 1 < knots.length ? knots[k + 1] : knots[0] + n;
    const seg: Pt[] = [];
    for (let i = a; i <= b; i++) {
      const idx = ((i % n) + n) % n;
      // the first and last point come from the unsmoothed ring so the emitted
      // chain stays exactly watertight across arcs
      seg.push(i === a || i === b ? ring[idx] : smooth[idx]);
    }
    if (seg.length < 2) continue;
    // Tangents along the arms that actually meet at the knot (corner-correct).
    const t1 = unit({ x: ring[(a + 1) % n].x - ring[((a % n) + n) % n].x, y: ring[(a + 1) % n].y - ring[((a % n) + n) % n].y });
    const t2 = unit({
      x: ring[(((b - 1) % n) + n) % n].x - ring[((b % n) + n) % n].x,
      y: ring[(((b - 1) % n) + n) % n].y - ring[((b % n) + n) % n].y,
    });
    const fall1 = unit({ x: seg[1].x - seg[0].x, y: seg[1].y - seg[0].y });
    const fall2 = unit({
      x: seg[seg.length - 2].x - seg[seg.length - 1].x,
      y: seg[seg.length - 2].y - seg[seg.length - 1].y,
    });
    const fitted = fitCubic(
      seg,
      t1.x === 0 && t1.y === 0 ? fall1 : t1,
      t2.x === 0 && t2.y === 0 ? fall2 : t2,
      o.fitError,
    );
    for (const c of fitted) {
      if (out.length) c.p0 = out[out.length - 1].p1;
      out.push(c);
    }
  }
  return out;
}

function fmt(v: number, p: number): string {
  return `${Math.round(v * 10 ** p) / 10 ** p}`;
}

function toPathData(curves: Cubic[], p: number): string {
  if (!curves.length) return "";
  let d = `M${fmt(curves[0].p0.x, p)} ${fmt(curves[0].p0.y, p)}`;
  for (const c of curves) {
    d += `C${fmt(c.c1.x, p)} ${fmt(c.c1.y, p)} ${fmt(c.c2.x, p)} ${fmt(c.c2.y, p)} ${fmt(c.p1.x, p)} ${fmt(c.p1.y, p)}`;
  }
  return `${d}Z`;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Extract the raw sub-pixel contour rings of a region mask (exposed for tests). */
export function extractRings(
  mask: Uint8Array,
  w: number,
  h: number,
  bbox: [number, number, number, number],
  sigma: number,
): { rings: Pt[][]; fieldMin: number; fieldMax: number; crossings: number } {
  const [bx0, by0, bx1, by1] = bbox;
  const margin = Math.max(2, Math.ceil(sigma * 3) + 1);
  const { field, fw, fh } = fieldFromMask(mask, w, h, bx0 - margin, by0 - margin, bx1 + margin, by1 + margin, sigma);
  let fieldMin = Infinity;
  let fieldMax = -Infinity;
  for (const v of field) {
    if (v < fieldMin) fieldMin = v;
    if (v > fieldMax) fieldMax = v;
  }
  const rings = marchingSquares(field, fw, fh, bx0 - margin, by0 - margin);
  return { rings, fieldMin, fieldMax, crossings: rings.reduce((s, r) => s + r.length, 0) };
}

export interface Contoured {
  d: string;
  /** Enclosed area in square working pixels — used for layer ordering. */
  area: number;
  curves: number;
}

/**
 * Trace one region mask. Returns one entry per surviving contour, all in *image*
 * coordinates matching the mask's own pixel grid.
 */
export function contoursForMask(
  mask: Uint8Array,
  w: number,
  h: number,
  bbox: [number, number, number, number],
  o: CoreOptions,
): Contoured[] {
  const [bx0, by0, bx1, by1] = bbox;
  if (bx1 < bx0 || by1 < by0) return [];
  const margin = Math.max(2, Math.ceil(o.sigma * 3) + 1);
  const { field, fw, fh } = fieldFromMask(mask, w, h, bx0 - margin, by0 - margin, bx1 + margin, by1 + margin, o.sigma);
  const rings = marchingSquares(field, fw, fh, bx0 - margin, by0 - margin);
  const out: Contoured[] = [];
  for (const ring of rings) {
    const area = Math.abs(ringArea(ring));
    if (area < o.minArea) continue;
    const curves = fitRing(ring, o);
    const d = toPathData(curves, o.precision);
    if (d) out.push({ d, area, curves: curves.length });
  }
  return out;
}

/** Per-label pixel count and bounding box, in one pass over the label map. */
export function labelStats(
  labels: Uint16Array,
  w: number,
  h: number,
  count: number,
): { bbox: [number, number, number, number]; pixels: number }[] {
  const stats = Array.from({ length: count }, () => ({
    bbox: [w, h, -1, -1] as [number, number, number, number],
    pixels: 0,
  }));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = labels[row + x];
      if (l >= count) continue;
      const s = stats[l];
      s.pixels++;
      if (x < s.bbox[0]) s.bbox[0] = x;
      if (y < s.bbox[1]) s.bbox[1] = y;
      if (x > s.bbox[2]) s.bbox[2] = x;
      if (y > s.bbox[3]) s.bbox[3] = y;
    }
  }
  return stats;
}

export function hex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}
