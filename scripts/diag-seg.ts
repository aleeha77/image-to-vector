/**
 * Diagnose what the segmentation actually produced: per region, its area, mean
 * width, mean colour and modal colour, and how many neighbours it has.
 *
 * Usage: bun scripts/diag-seg.ts [fixture] [preset]
 */
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { TUNING, type PresetId } from "../src/trace.server";

const LAB = "/home/team/shared/trace-lab";
const fixture = process.argv[2] ?? "logo-flat.png";
const preset = (process.argv[3] ?? "logo") as PresetId;
const t = TUNING[preset];

const input = await readFile(`${LAB}/fixtures/${fixture}`);
let pipe = sharp(input).flatten({ background: "#ffffff" }).toColourspace("srgb");
if (t.denoise > 1) pipe = pipe.median(t.denoise);
if (t.blur > 0) pipe = pipe.blur(t.blur);
const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
const w = info.width;
const h = info.height;

// Re-implement only the *reporting* part by importing the internals through a
// tiny instrumented copy: growth is cheap, so re-running it here is fine.
const { segment, modalColours } = await import("../src/segment");
const detail = 0.5;
const tolerance = t.tolerance[0] + (t.tolerance[1] - t.tolerance[0]) * detail;
const minArea = t.minArea[0] + (t.minArea[1] - t.minArea[0]) * detail;
const seg = segment(data, 3, w, h, {
  tolerance,
  maxRegions: Math.round(t.regions[0] + (t.regions[1] - t.regions[0]) * detail),
  minArea,
  mergeBands: t.mergeBands,
  bandWidth: t.bandWidth,
});
const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
console.log(`tolerance ${String(seg.tolerance)} grown ${String(seg.grown)} bands ${String(seg.bandMerges)} specks ${String(seg.smallMerges)} -> ${String(seg.count)} regions`);
// per-region pixel count + boundary length
const area = new Int32Array(seg.count);
const perim = new Int32Array(seg.count);
const nbr: Map<number, number>[] = [];
for (let i = 0; i < seg.count; i++) nbr.push(new Map());
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const l = seg.labels[i];
    area[l]++;
    const nb: number[] = [];
    if (x > 0) nb.push(i - 1);
    if (x < w - 1) nb.push(i + 1);
    if (y > 0) nb.push(i - w);
    if (y < h - 1) nb.push(i + w);
    let edge = x === 0 || x === w - 1 || y === 0 || y === h - 1;
    for (const q of nb) if (seg.labels[q] !== l) edge = true;
    if (edge) perim[l]++;
    for (const q of nb) {
      const o = seg.labels[q];
      if (o === l) continue;
      nbr[l].set(o, (nbr[l].get(o) ?? 0) + 1);
    }
  }
}
const palette = modalColours(seg.labels, data, seg.count);
const bbox = Array.from({ length: seg.count }, () => [w, h, -1, -1]);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const l = seg.labels[y * w + x];
    const b = bbox[l];
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
}
for (let l = 0; l < seg.count; l++) {
  const width = (2 * area[l]) / Math.max(1, perim[l]);
  const top = [...nbr[l].entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(
    `[${String(l).padStart(2)}] ${hex(palette[l])} area=${String(area[l]).padStart(7)} width=${width.toFixed(2)} bbox=${JSON.stringify(bbox[l])} nbr=${top
      .map(([o, c]) => `${String(o)}:${hex(palette[o])}(${String(c)})`)
      .join(" ")}`,
  );
}
