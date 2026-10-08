/**
 * Diagnostic 2: does the 1px hairline survive as a long region, and at which
 * segmentation tolerance? Prints every region whose bounding box spans more than
 * 100px, with its colour, pixel count and fill ratio, for a few tolerances.
 */
import sharp from "sharp";
import { segment } from "../src/segment";
import { labelStats } from "../src/trace-core.server";
import { TUNING } from "../src/trace.server";

const t = TUNING.pattern;
const src = await (await import("sharp")).default;
const pipeline = src("/home/team/shared/trace-lab/fixtures/pattern-textile.png")
  .flatten({ background: "#ffffff" })
  .toColourspace("srgb")
  .modulate({ saturation: t.saturation });
const { data: rgb, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
const w = info.width;
const h = info.height;
console.log(`working ${w}x${h}`);

for (const [tol, cap, label] of [
  [15, 100000, "tolerance 15, uncapped"],
  [22, 100000, "tolerance 22, uncapped"],
  [36, 100000, "tolerance 36, uncapped"],
  [15, 550, "tolerance 15, cap 550 (escalates)"],
  [12, 550, "tolerance 12, cap 550 (escalates)"],
] as [number, number, string][]) {
  const seg = segment(rgb, 3, w, h, {
    tolerance: tol,
    maxRegions: cap,
    minArea: 3.5,
    mergeBands: t.mergeBands,
    bandWidth: t.bandWidth,
  });
  const stats = labelStats(seg.labels, w, h, seg.count);
  const long: string[] = [];
  for (let l = 0; l < seg.count; l++) {
    const [x0, y0, x1, y1] = stats[l].bbox;
    const span = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    if (span < 100) continue;
    const fill = stats[l].pixels / ((x1 - x0 + 1) * (y1 - y0 + 1));
    long.push(
      `#${seg.palette[l].toString(16).padStart(6, "0")} px=${stats[l].pixels} ` +
        `${x1 - x0 + 1}x${y1 - y0 + 1} fill=${fill.toFixed(3)}`,
    );
  }
  long.sort((a, b) => Number(b.split("px=")[1].split(" ")[0]) - Number(a.split("px=")[1].split(" ")[0]));
  console.log(`\n[${label}] -> ${seg.count} regions, tolerance used ${Math.round(seg.tolerance)}, bandMerges ${seg.bandMerges}`);
  console.log(`  long regions: ${long.length}`);
  for (const s of long.slice(0, 10)) console.log(`   ${s}`);
}
