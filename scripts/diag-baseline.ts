/**
 * Baseline diagnostic: how bad is the *current* engine, measured rather than felt?
 *
 * Prints, for the line-art fixture:
 *  - the raster's own score against the vector ground truth (the ceiling),
 *  - the current engine's score,
 *  - the 45-degree straightness residual of both,
 *  - structural facts about the SVG (image elements, base64, viewBox).
 */
import { readFile } from "node:fs/promises";
import { traceImage } from "../src/trace.server";
import {
  type Box,
  compose,
  cropNearest,
  inkMask,
  rasterise,
  rasteriseImage,
  save,
  score,
} from "./lib";

const LAB = "/home/team/shared/trace-lab";
const FIX = `${LAB}/fixtures`;
const ZOOM = 8;

const png = await readFile(`${FIX}/lineart-thin-diagonal.png`);
const truthSvg = await readFile(`${FIX}/lineart-source.svg`, "utf8");

// The diagonal from (760,120)->(1300,660) has slope exactly 1: in a crop whose
// top-left is (900,260) the stroke centreline lies on x == y (source px).
const BOX: Box = { x: 900, y: 260, w: 110, h: 110 };
const deviceBox: Box = { x: BOX.x * ZOOM, y: BOX.y * ZOOM, w: BOX.w * ZOOM, h: BOX.h * ZOOM };
const diag = { y0: 8, y1: deviceBox.h - 8, xAt: (y: number) => y, halfWidth: 48 };

const truth = await rasterise(truthSvg, ZOOM);
const original = await rasteriseImage(png, ZOOM, "nearest");
const originalSmooth = await rasteriseImage(png, ZOOM, "lanczos3");

console.log("fixture raster ceiling (vs vector truth):", JSON.stringify(score(truth, original, deviceBox, { diagonal: diag })));
console.log("  (smooth-scaled raster)                 :", JSON.stringify(score(truth, originalSmooth, deviceBox, { diagonal: diag })));

const panels = [
  { img: cropNearest(png, BOX, ZOOM), label: `ORIGINAL RASTER ${String(ZOOM)}00% (nearest - the actual pixels)` },
];

for (const preset of ["lineart", "logo"] as const) {
  const res = await traceImage(png, { preset, detail: 0.5 });
  await save(`${LAB}/_scratch/baseline-${preset}.svg`, Buffer.from(res.svg, "utf8"));
  const svgW = res.width;
  const deviceScale = (ZOOM * 1400) / svgW; // device px per source px
  const got = await rasterise(res.svg, deviceScale);
  const box: Box = {
    x: Math.round(BOX.x * deviceScale),
    y: Math.round(BOX.y * deviceScale),
    w: Math.round(BOX.w * deviceScale),
    h: Math.round(BOX.h * deviceScale),
  };
  const s = score(truth, got, box, { diagonal: { ...diag, y0: 8, y1: box.h - 8, halfWidth: Math.round(48 * (deviceScale / ZOOM)) } });
  const meta = { preset, svg: `${String(svgW)}x${String(res.height)}`, paths: res.pathCount, colours: res.colourCount, bytes: res.bytes, ms: res.ms };
  console.log("BASELINE", JSON.stringify(meta));
  console.log("  score:", JSON.stringify(s));
  console.log("  <image>:", /<image\b/.test(res.svg), "base64:", /base64/.test(res.svg), "viewBox:", /viewBox="0 0 \d+ \d+"/.test(res.svg));
  console.log("  steps:", res.steps.join(" | "));
  console.log("  head:", res.svg.slice(0, 200).replace(/\n/g, " "));
  console.log("  path sample:", (res.svg.match(/<path[^>]{0,180}/) ?? [""])[0]);
  console.log("  ink mask px:", inkMask(got).reduce((a, b) => a + b, 0));
  panels.push({
    img: cropRaw(got, box, BOX.w * ZOOM, BOX.h * ZOOM),
    label: `${preset.toUpperCase()} PRESET - current engine, ${String(ZOOM)}00%`,
  });
}

function cropRaw(img: { data: Buffer; width: number; height: number }, box: Box, outW: number, outH: number) {
  const out = Buffer.alloc(outW * outH * 4, 255);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(img.height - 1, box.y + Math.round((y * box.h) / outH));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(img.width - 1, box.x + Math.round((x * box.w) / outW));
      const s = (sy * img.width + sx) * 4;
      const d = (y * outW + x) * 4;
      out[d] = img.data[s];
      out[d + 1] = img.data[s + 1];
      out[d + 2] = img.data[s + 2];
      out[d + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

await save(`${LAB}/_scratch/baseline-compare.png`, await compose(panels));
console.log("wrote baseline-compare.png");
