/**
 * Render a traced SVG (or all of them) next to its source fixture at view scale,
 * so a whole-image defect (missing layers, wrong background) is visible at a glance.
 *
 * Usage: bun scripts/full-view.ts [preset ...]
 */
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";

const LAB = "/home/team/shared/trace-lab";
const PAIRS: [string, string, string][] = [
  ["lineart", "lineart-thin-diagonal.png", "lineart.svg"],
  ["logo", "logo-flat.png", "logo.svg"],
  ["photo", "photo-portrait.jpg", "photo.svg"],
  ["pattern", "pattern-textile.png", "pattern.svg"],
];

const wanted = process.argv.slice(2);
const only = wanted.length ? PAIRS.filter((p) => wanted.includes(p[0])) : PAIRS;
const SIZE = 760;

for (const [preset, fixture, svgName] of only) {
  let svg: string;
  try {
    svg = await readFile(`${LAB}/svg/${svgName}`, "utf8");
  } catch {
    continue;
  }
  const src = await sharp(`${LAB}/fixtures/${fixture}`)
    .resize(SIZE, SIZE, { fit: "inside", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const sm = await sharp(src).metadata();
  const traced = await sharp(Buffer.from(svg), { density: 72 })
    .resize(SIZE, SIZE, { fit: "inside" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  const tm = await sharp(traced).metadata();
  const h = Math.max(sm.height ?? 0, tm.height ?? 0) + 10;
  const w = (sm.width ?? 0) + (tm.width ?? 0) + 15;
  const out = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 220, g: 40, b: 200, alpha: 1 } },
  })
    .composite([
      { input: src, left: 5, top: 5 },
      { input: traced, left: (sm.width ?? 0) + 10, top: 5 },
    ])
    .png()
    .toBuffer();
  await writeFile(`${LAB}/_scratch/full-${preset}.png`, out);
  console.log(`${preset}: wrote full-${preset}.png ${String(w)}x${String(h)}`);
}
