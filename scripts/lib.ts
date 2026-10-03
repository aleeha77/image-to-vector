/**
 * trace-lab measurement + evidence library (dev only, not part of the app).
 *
 * Everything here is about *measuring* a traced SVG honestly:
 *  - rasterise the SVG with librsvg at a chosen zoom,
 *  - render the ground truth (the fixture's own source SVG, when we have one) at
 *    the same zoom,
 *  - compare the two, and
 *  - write side-by-side crop images a human can look at.
 */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";

export interface Raw {
  data: Buffer; // RGBA
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rasterise an SVG at `scale` device px per SVG user unit (viewBox unit). */
export async function rasterise(svg: string, scale: number): Promise<Raw> {
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 * scale })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Rasterise a raster image at `scale` device px per source px (lanczos). */
export async function rasteriseImage(
  img: Buffer,
  scale: number,
  kernel: keyof sharp.KernelEnum = "lanczos3",
): Promise<Raw> {
  const meta = await sharp(img).metadata();
  const { data, info } = await sharp(img)
    .resize(Math.round((meta.width ?? 0) * scale), Math.round((meta.height ?? 0) * scale), {
      kernel: kernel as never,
      fit: "fill",
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Crop a Raw, blitting onto an opaque background first (so alpha cannot lie). */
export function crop(img: Raw, box: Box, bg = 255): Raw {
  const out = Buffer.alloc(box.w * box.h * 4, bg);
  for (let y = 0; y < box.h; y++) {
    const sy = box.y + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < box.w; x++) {
      const sx = box.x + x;
      if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4;
      const d = (y * box.w + x) * 4;
      const a = img.data[s + 3] / 255;
      for (let c = 0; c < 3; c++) {
        out[d + c] = Math.round(img.data[s + c] * a + bg * (1 - a));
      }
      out[d + 3] = 255;
    }
  }
  return { data: out, width: box.w, height: box.h };
}

export function toRawPng(img: Raw): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export function luma(img: Raw, i: number): number {
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
}

/** Binary "is this pixel ink?" mask. */
export function inkMask(img: Raw, threshold = 160): Uint8Array {
  const n = img.width * img.height;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = luma(img, i * 4) < threshold ? 1 : 0;
  return m;
}

/**
 * Two-pass chamfer distance transform (in device px) from the set pixels of `m`.
 */
export function distanceTransform(m: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = m[i] ? 0 : INF;
  const a = 1;
  const b = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) v = Math.min(v, d[i - w] + a);
      if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + b);
      if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + b);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) v = Math.min(v, d[i + w] + a);
      if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + b);
      if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + b);
      d[i] = v;
    }
  }
  return d;
}

/** Boundary pixels of a mask (any 4-neighbour disagrees). */
export function boundary(m: Uint8Array, w: number, h: number): Uint8Array {
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = m[i];
      const l = x > 0 ? m[i - 1] : v;
      const r = x < w - 1 ? m[i + 1] : v;
      const u = y > 0 ? m[i - w] : v;
      const dn = y < h - 1 ? m[i + w] : v;
      if (l !== v || r !== v || u !== v || dn !== v) b[i] = 1;
    }
  }
  return b;
}

export interface FitScore {
  /** Mean distance (source px) from a traced outline pixel to the nearest truth outline pixel. */
  meanPx: number;
  p95Px: number;
  /** IoU of the ink masks. */
  iou: number;
  /** Row-wise centreline fit residual (source px) — the staircase detector. */
  straightRmsPx: number;
  straightP95Px: number;
  rows: number;
}

/**
 * Compare a traced render against a ground-truth render, both already at the same
 * device scale, restricted to `box` (device px).
 */
export function score(
  truth: Raw,
  got: Raw,
  box: Box,
  opts: { diagonal?: { y0: number; y1: number; xAt: (y: number) => number; halfWidth: number } } = {},
): FitScore {
  const t = crop(truth, box);
  const g = crop(got, box);
  const w = t.width;
  const h = t.height;
  const tm = inkMask(t);
  const gm = inkMask(g);
  const tb = boundary(tm, w, h);
  const gb = boundary(gm, w, h);
  const dt = distanceTransform(tb, w, h);
  const dg = distanceTransform(gb, w, h);

  let n = 0;
  let sum = 0;
  const far: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (gb[i]) {
      const d = dt[i];
      sum += d;
      far.push(d);
      n++;
    }
  }
  far.sort((a, b) => a - b);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < w * h; i++) {
    if (tm[i] && gm[i]) inter++;
    if (tm[i] || gm[i]) union++;
  }
  // reverse distance too (a dropped feature shows up here)
  let sum2 = 0;
  let n2 = 0;
  for (let i = 0; i < w * h; i++) {
    if (tb[i]) {
      sum2 += dg[i];
      n2++;
    }
  }
  void sum2;
  void n2;

  let straightRmsPx = NaN;
  let straightP95Px = NaN;
  let rows = 0;
  if (opts.diagonal) {
    const { y0, y1, xAt, halfWidth } = opts.diagonal;
    const resid: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
      const cx = xAt(y);
      const x0 = Math.max(0, Math.floor(cx - halfWidth));
      const x1 = Math.min(w - 1, Math.ceil(cx + halfWidth));
      let ws = 0;
      let wsum = 0;
      let dark = 0;
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const wgt = 255 - luma(g, i * 4);
        ws += wgt;
        wsum += wgt * x;
        if (wgt > 160) dark++;
      }
      if (ws < 200 || dark < 1 || dark > (x1 - x0) * 0.9) continue;
      xs.push(wsum / ws);
      ys.push(y);
    }
    if (ys.length > 8) {
      const n1 = ys.length;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < n1; i++) {
        sx += ys[i];
        sy += xs[i];
        sxx += ys[i] * ys[i];
        sxy += ys[i] * xs[i];
      }
      const slope = (n1 * sxy - sx * sy) / (n1 * sxx - sx * sx);
      const icept = (sy - slope * sx) / n1;
      for (let i = 0; i < n1; i++) resid.push(Math.abs(xs[i] - (slope * ys[i] + icept)));
      resid.sort((a, b) => a - b);
      straightRmsPx = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / resid.length);
      straightP95Px = resid[Math.floor(resid.length * 0.95)];
      rows = resid.length;
    }
  }

  return {
    meanPx: n ? sum / n : NaN,
    p95Px: far.length ? far[Math.floor(far.length * 0.95)] : NaN,
    iou: union ? inter / union : 1,
    straightRmsPx,
    straightP95Px,
    rows,
  };
}

/** Nearest-neighbour view of a raster crop (shows the pixels it actually has). */
export async function cropNearest(img: Buffer, box: Box, zoom: number): Promise<Raw> {
  const { data, info } = await sharp(img)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .resize(Math.round(box.w * zoom), Math.round(box.h * zoom), { kernel: "nearest" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Best-case view of a raster crop (lanczos) — how a viewer would show it zoomed. */
export async function cropSmooth(img: Buffer, box: Box, zoom: number): Promise<Raw> {
  const { data, info } = await sharp(img)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .resize(Math.round(box.w * zoom), Math.round(box.h * zoom), { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const LABEL_H = 34;

function labelSvg(text: string, w: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(w)}" height="${String(LABEL_H)}">
    <rect width="${String(w)}" height="${String(LABEL_H)}" fill="#101418"/>
    <text x="8" y="24" font-family="DejaVu Sans, sans-serif" font-size="20" fill="#ffffff">${text}</text>
  </svg>`;
}

export interface Panel {
  img: Raw;
  label: string;
}

/** Compose panels side by side with labels, on a dark background. */
export async function compose(panels: Panel[], gap = 16, divider = 3): Promise<Buffer> {
  const w = panels.reduce((s, p) => s + p.img.width, 0) + gap * (panels.length + 1);
  const contentH = Math.max(...panels.map((p) => p.img.height));
  const h = contentH + LABEL_H + gap * 2;
  const base = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    base[i * 4 + 0] = 26;
    base[i * 4 + 1] = 30;
    base[i * 4 + 2] = 36;
    base[i * 4 + 3] = 255;
  }
  const canvas: Raw = { data: base, width: w, height: h };
  let x = gap;
  const blit = (src: Raw, ox: number, oy: number) => {
    for (let y = 0; y < src.height; y++) {
      for (let xx = 0; xx < src.width; xx++) {
        const dx = ox + xx;
        const dy = oy + y;
        if (dx < 0 || dy < 0 || dx >= canvas.width || dy >= canvas.height) continue;
        const s = (y * src.width + xx) * 4;
        const d = (dy * canvas.width + dx) * 4;
        canvas.data[d] = src.data[s];
        canvas.data[d + 1] = src.data[s + 1];
        canvas.data[d + 2] = src.data[s + 2];
        canvas.data[d + 3] = 255;
      }
    }
  };
  for (const p of panels) {
    const lab = await rasterise(labelSvg(p.label, p.img.width), 1);
    blit(lab, x, gap);
    blit(p.img, x, gap + LABEL_H);
    // divider
    for (let y = gap; y < gap + LABEL_H + contentH; y++) {
      for (let k = 0; k < divider; k++) {
        const dx = x + p.img.width + k;
        const d = (y * canvas.width + dx) * 4;
        if (dx < canvas.width) {
          canvas.data[d] = 255;
          canvas.data[d + 1] = 255;
          canvas.data[d + 2] = 255;
        }
      }
    }
    x += p.img.width + gap;
  }
  return toRawPng(canvas);
}

export async function save(path: string, buf: Buffer): Promise<void> {
  await writeFile(path, buf);
}
