/**
 * Flat-colour region segmentation — the label map the sub-pixel tracer contours.
 *
 * Why this replaced a global colour quantiser (median cut over a 5-bit
 * histogram): a palette is a *global* average, and the anti-aliased ramp along
 * every edge is a mix of the two colours it sits between. Handing that ramp to
 * a global quantiser makes the ramp pixels — and often whole small regions —
 * vote for whichever box happens to own them. On flat art that is fatal: the
 * logo fixture's red disc, green disc and white paper ended up in *one* box, so
 * the trace rendered white+red+green as a single averaged (grey) layer. The red
 * and green layers did not exist at all, and "white" came out grey.
 *
 * So we segment instead of quantising:
 *
 *  1. region growing — a pixel joins a region when its colour is within
 *     `tolerance` of the region's *seed* colour. No global averaging, so a flat
 *     region keeps its exact colour;
 *  2. anti-aliasing bands are merged away. An AA band is a thin region whose
 *     colour lies *between* the colours of its two dominant neighbours. A real
 *     hairline fails that test, because its own ink colour is not a mix of what
 *     surrounds it — which is what lets us delete AA bands while keeping 1px
 *     hairlines and small dots;
 *  3. leftover specks under `minArea` are merged into their closest-coloured
 *     neighbour;
 *  4. only then, if the image still has more regions than the preset's budget,
 *     the tolerance is raised and the whole thing runs again. (Merging first
 *     matters: a tight tolerance fragments every AA ramp into a chain of 1px
 *     regions, so counting regions *before* merging would drive the tolerance
 *     far too coarse and destroy the flat art this preset exists for.);
 *  5. each surviving region's colour is its *modal* colour (the most populous
 *     colour bin), not its mean — so paper stays exactly #ffffff instead of
 *     drifting grey as its anti-aliased rim is folded in.
 *
 * The pixel-level sub-pixel work happens downstream: `layerCoverage` turns this
 * hard label map into a coverage field by unmixing each boundary pixel's colour
 * between its own region and its neighbour, which is where the 50%-coverage
 * contour actually lives.
 */

export interface SegmentOptions {
  /** Chebyshev RGB distance (0-255) at which a pixel joins a growing region. */
  tolerance: number;
  /** Raise the tolerance until at most this many regions remain. */
  maxRegions: number;
  /** Regions smaller than this (px) are merged into their closest neighbour. */
  minArea: number;
  /**
   * Merge anti-aliasing bands. True for flat art (logo, pattern, line art);
   * for photographs only the very thinnest bands qualify, because a gradient
   * step is a legitimate blend of its neighbours and merging those would
   * dissolve the picture.
   */
  mergeBands: boolean;
  /** Maximum mean width (px) of a region that may still count as an AA band. */
  bandWidth?: number;
  /** Ceiling for the tolerance search. */
  maxTolerance?: number;
}

export interface Segmented {
  /** Region index per pixel, row-major, largest region first. */
  labels: Uint16Array;
  /** Region colours, packed 0xRRGGBB, indexed by label. */
  palette: number[];
  /** Region pixel counts, aligned with `palette`. */
  areas: Int32Array;
  /** Total regions after merging. */
  count: number;
  /** Tolerance actually used. */
  tolerance: number;
  /** Regions found by raw growth, before merging — the honest oversegmentation. */
  grown: number;
  bandMerges: number;
  smallMerges: number;
}

/** One pass of seeded region growing. Returns the region count. */
function grow(
  rgb: Buffer,
  channels: number,
  w: number,
  h: number,
  tolerance: number,
  labels: Int32Array,
  stack: Int32Array,
): number {
  const n = w * h;
  labels.fill(-1);
  let count = 0;
  for (let seed = 0; seed < n; seed++) {
    if (labels[seed] >= 0) continue;
    const id = count++;
    const ps = seed * channels;
    const r0 = rgb[ps];
    const g0 = rgb[ps + 1];
    const b0 = rgb[ps + 2];
    let sp = 0;
    stack[sp++] = seed;
    labels[seed] = id;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (labels[q] >= 0) continue;
          const pq = q * channels;
          const cr = rgb[pq];
          if (cr - r0 > tolerance || r0 - cr > tolerance) continue;
          const cg = rgb[pq + 1];
          if (cg - g0 > tolerance || g0 - cg > tolerance) continue;
          const cb = rgb[pq + 2];
          if (cb - b0 > tolerance || b0 - cb > tolerance) continue;
          labels[q] = id;
          stack[sp++] = q;
        }
      }
    }
  }
  return count;
}

export interface Cleaned {
  labels: Uint16Array;
  areas: Int32Array;
  count: number;
  bandMerges: number;
  smallMerges: number;
}

/**
 * Merge AA bands and specks out of a raw growth, then renumber the regions
 * largest-first so label order *is* paint order.
 */
function cleanup(
  raw: Int32Array,
  grown: number,
  rgb: Buffer,
  channels: number,
  w: number,
  h: number,
  o: SegmentOptions,
): Cleaned {
  const n = w * h;
  const area = new Int32Array(grown);
  const perim = new Int32Array(grown);
  const sum = new Float64Array(grown * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const l = raw[i];
      area[l]++;
      const p = i * channels;
      sum[l * 3] += rgb[p];
      sum[l * 3 + 1] += rgb[p + 1];
      sum[l * 3 + 2] += rgb[p + 2];
      if (
        x === 0 ||
        x === w - 1 ||
        y === 0 ||
        y === h - 1 ||
        raw[i - 1] !== l ||
        raw[i + 1] !== l ||
        raw[i - w] !== l ||
        raw[i + w] !== l
      ) {
        perim[l]++;
      }
    }
  }

  // Pixel lists per region (CSR), so a merge candidate can inspect its own
  // pixels' neighbourhood cheaply instead of rescanning the image.
  const offsets = new Int32Array(grown + 1);
  for (let l = 0; l < grown; l++) offsets[l + 1] = offsets[l] + area[l];
  const cursor = offsets.slice(0, grown);
  const pixels = new Int32Array(n);
  for (let i = 0; i < n; i++) pixels[cursor[raw[i]]++] = i;

  const rep = new Int32Array(grown);
  for (let l = 0; l < grown; l++) rep[l] = l;
  const find = (x: number): number => {
    let r = x;
    while (rep[r] !== r) r = rep[r];
    while (rep[x] !== r) {
      const next = rep[x];
      rep[x] = r;
      x = next;
    }
    return r;
  };
  const meanOf = (l: number): [number, number, number] => {
    const a = Math.max(1, area[l]);
    return [sum[l * 3] / a, sum[l * 3 + 1] / a, sum[l * 3 + 2] / a];
  };

  /** 8-neighbour regions around region `l`, with how many border pixels each shares. */
  const neighboursOf = (l: number): Map<number, number> => {
    const tally = new Map<number, number>();
    for (let k = offsets[l]; k < offsets[l + 1]; k++) {
      const i = pixels[k];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const other = find(raw[ny * w + nx]);
          if (other === l) continue;
          tally.set(other, (tally.get(other) ?? 0) + 1);
        }
      }
    }
    return tally;
  };

  const merge = (from: number, into: number) => {
    rep[from] = into;
    area[into] += area[from];
    perim[into] += perim[from];
    sum[into * 3] += sum[from * 3];
    sum[into * 3 + 1] += sum[from * 3 + 1];
    sum[into * 3 + 2] += sum[from * 3 + 2];
    area[from] = 0;
    perim[from] = 0;
    sum[from * 3] = 0;
    sum[from * 3 + 1] = 0;
    sum[from * 3 + 2] = 0;
  };

  // Region ids ordered smallest-first: merging thin/small things first moves
  // the least colour and geometry.
  const order = Array.from({ length: grown }, (_, l) => l).sort((a, b) => area[a] - area[b]);

  // --- pass 1: anti-aliasing bands -------------------------------------
  let bandMerges = 0;
  const bandWidth = o.bandWidth ?? 3.2;
  if (o.mergeBands) {
    for (const l of order) {
      if (rep[l] !== l || area[l] === 0) continue;
      const width = (2 * area[l]) / Math.max(1, perim[l]);
      if (width >= bandWidth) continue;
      const tally = neighboursOf(l);
      const c = meanOf(l);
      if (tally.size === 0) continue;
      if (tally.size === 1) {
        // A thin sliver with one neighbour can only be a duplicate of it (JPEG
        // ringing, a rendered rim): merge only when the colours agree, so a
        // real hairline of a different ink is never swallowed.
        const only = [...tally.keys()][0];
        const q = meanOf(only);
        const d = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2;
        if (d < 20 * 20) {
          merge(l, only);
          bandMerges++;
        }
        continue;
      }
      const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      let done = false;
      // Try the two most-shared neighbours, then the next pair: a band at a
      // junction can have its two real sides either side of a third region.
      for (let k = 0; k < Math.min(ranked.length, 3) && !done; k++) {
        for (let m = k + 1; m < Math.min(ranked.length, 4) && !done; m++) {
          const n1 = ranked[k][0];
          const n2 = ranked[m][0];
          const a = meanOf(n1);
          const b = meanOf(n2);
          const abx = b[0] - a[0];
          const aby = b[1] - a[1];
          const abz = b[2] - a[2];
          const len2 = abx * abx + aby * aby + abz * abz;
          if (len2 < 40 * 40) continue; // the two sides are too alike to make a blend
          const t = ((c[0] - a[0]) * abx + (c[1] - a[1]) * aby + (c[2] - a[2]) * abz) / len2;
          const ex = a[0] + t * abx - c[0];
          const ey = a[1] + t * aby - c[1];
          const ez = a[2] + t * abz - c[2];
          if (ex * ex + ey * ey + ez * ez > 14 * 14) continue;
          // t ~ 1 means the sliver's colour is n2's, t ~ 0 means it is n1's —
          // at the tangents of a curve a rim collapses to one side, and then the
          // colour itself says which side to join. In between it is a real blend
          // of both, so join the bigger one (a long thin band must never drag a
          // small region's colour across the image).
          const target = t >= 0.9 ? n2 : t <= 0.1 ? n1 : area[n1] >= area[n2] ? n1 : n2;
          merge(l, target);
          bandMerges++;
          done = true;
        }
      }
    }
  }

  // --- pass 2: specks ---------------------------------------------------
  let smallMerges = 0;
  for (const l of order) {
    if (rep[l] !== l || area[l] === 0 || area[l] >= o.minArea) continue;
    const tally = neighboursOf(l);
    if (tally.size === 0) continue;
    const c = meanOf(l);
    let best = -1;
    let bestScore = Infinity;
    for (const [nb, border] of tally) {
      const q = meanOf(nb);
      // Closest colour wins; a long shared border breaks the tie.
      const score = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2 - border * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = nb;
      }
    }
    if (best < 0) continue;
    merge(l, best);
    smallMerges++;
  }

  // --- renumber, largest first -----------------------------------------
  const rootIndex = new Int32Array(grown).fill(-1);
  const temp = new Uint16Array(n);
  const counts: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = find(raw[i]);
    let idx = rootIndex[r];
    if (idx < 0) {
      idx = counts.length;
      rootIndex[r] = idx;
      counts.push(area[r]);
    }
    temp[i] = idx;
  }
  const count = counts.length;
  const rank = new Int32Array(count);
  Array.from({ length: count }, (_, i) => i)
    .sort((a, b) => counts[b] - counts[a])
    .forEach((idx, r) => {
      rank[idx] = r;
    });
  const labels = new Uint16Array(n);
  for (let i = 0; i < n; i++) labels[i] = rank[temp[i]];
  const areas = new Int32Array(count);
  for (let i = 0; i < n; i++) areas[labels[i]]++;
  return { labels, areas, count, bandMerges, smallMerges };
}

/** Segmented label map + per-region colours for an RGB buffer. */
export function segment(rgb: Buffer, channels: number, w: number, h: number, o: SegmentOptions): Segmented {
  const n = w * h;
  const raw = new Int32Array(n);
  const stack = new Int32Array(n);
  const maxTolerance = o.maxTolerance ?? 110;

  let tolerance = o.tolerance;
  let grown = 0;
  let cleaned: Cleaned;
  let attempts = 0;
  for (;;) {
    grown = grow(rgb, channels, w, h, tolerance, raw, stack);
    cleaned = cleanup(raw, grown, rgb, channels, w, h, o);
    attempts++;
    if (cleaned.count <= o.maxRegions || tolerance >= maxTolerance || attempts >= 8) break;
    tolerance = Math.min(maxTolerance, tolerance * 1.55);
  }
  const palette = modalColours(cleaned.labels, rgb, cleaned.count);
  return {
    labels: cleaned.labels,
    palette,
    areas: cleaned.areas,
    count: cleaned.count,
    tolerance,
    grown,
    bandMerges: cleaned.bandMerges,
    smallMerges: cleaned.smallMerges,
  };
}

/**
 * Modal colour per label: the label's most populous 5-bit colour bin, averaged
 * over just that bin's pixels.
 *
 * This is the *mode*, not the mean, and that matters: a flat region's rim is
 * anti-aliased, so a mean drags the colour towards whatever is on the other side
 * of the edge. White paper would come out grey. The mode ignores that ramp
 * because the flat interior is far more populous than the rim.
 */
export function modalColours(labels: Uint16Array, rgb: Buffer, count: number): number[] {
  const n = labels.length;
  const bins: Map<number, [number, number, number, number]>[] = Array.from({ length: count }, () => new Map());
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const l = labels[i];
    if (l >= count) continue;
    const bin = ((rgb[p] >> 3) << 10) | ((rgb[p + 1] >> 3) << 5) | (rgb[p + 2] >> 3);
    let e = bins[l].get(bin);
    if (!e) {
      e = [0, 0, 0, 0];
      bins[l].set(bin, e);
    }
    e[0]++;
    e[1] += rgb[p];
    e[2] += rgb[p + 1];
    e[3] += rgb[p + 2];
  }
  const palette: number[] = [];
  for (let l = 0; l < count; l++) {
    let best: [number, number, number, number] | null = null;
    for (const e of bins[l].values()) if (!best || e[0] > best[0]) best = e;
    if (!best) {
      palette.push(0);
      continue;
    }
    const hits = Math.max(1, best[0]);
    palette.push((Math.round(best[1] / hits) << 16) | (Math.round(best[2] / hits) << 8) | Math.round(best[3] / hits));
  }
  return palette;
}
