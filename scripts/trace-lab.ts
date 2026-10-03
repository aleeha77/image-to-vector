/**
 * Tracecraft trace lab — evidence and measurement for the four presets.
 *
 * For every preset it:
 *   1. traces its fixture with the real engine,
 *   2. saves the .svg,
 *   3. renders it at high zoom and writes a side-by-side crop against the
 *      original raster (the same crop, the same zoom),
 *   4. scores the traced outline against the vector ground truth
 *      (mean / p95 outline distance in source px, ink IoU, and the straightness
 *      residual of a 45-degree edge) and reports what the *raster* itself
 *      scores on the same measures as a ceiling.
 *
 * Usage: bun scripts/trace-lab.ts [preset ...]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PRESET_IDS, traceImage, type PresetId } from "../src/trace.server";
import {
  type Box,
  type Raw,
  compose,
  cropNearest,
  cropSmooth,
  rasterise,
  rasteriseImage,
  save,
  score,
} from "./lib";

const LAB = "/home/team/shared/trace-lab";
const FIX = `${LAB}/fixtures`;
const OUT_SVG = `${LAB}/svg`;
const OUT_EV = `${LAB}/evidence`;

interface Shot {
  name: string;
  /** Crop in source pixels. */
  box: Box;
  zoom: number;
  /** Set when the crop contains a 45-degree edge lying on x == y (box coords). */
  diagonal?: boolean;
}

interface Case {
  preset: PresetId;
  fixture: string;
  /** Vector ground truth (synthetic fixtures only). */
  truth?: string;
  shots: Shot[];
}

const CASES: Case[] = [
  {
    preset: "lineart",
    fixture: "lineart-thin-diagonal.png",
    truth: "lineart-source.svg",
    shots: [
      // The 45-degree line runs from (760,120) to (1300,660): slope 1, so in this
      // crop it lies exactly on x == y. A staircase is unmissable here.
      { name: "diagonal", box: { x: 770, y: 130, w: 150, h: 150 }, zoom: 8, diagonal: true },
      // The r=180 circle: curvature, on a 2.4px stroke.
      { name: "curve", box: { x: 400, y: 110, w: 130, h: 130 }, zoom: 8 },
      // 2px strokes plus small text: hairlines and detail.
      { name: "hairlines", box: { x: 620, y: 170, w: 130, h: 130 }, zoom: 8 },
    ],
  },
  {
    preset: "logo",
    fixture: "logo-flat.png",
    truth: "logo-source.svg",
    shots: [
      // Circle / half-disc borders: flat hard edges meeting curves.
      { name: "circle", box: { x: 490, y: 320, w: 160, h: 160 }, zoom: 7 },
      // The wordmark over the hexagon: sharp glyph corners.
      { name: "text", box: { x: 430, y: 230, w: 150, h: 150 }, zoom: 7 },
    ],
  },
  {
    preset: "photo",
    fixture: "photo-portrait.jpg",
    shots: [{ name: "detail", box: { x: 300, y: 200, w: 160, h: 160 }, zoom: 6 }],
  },
  {
    preset: "pattern",
    fixture: "pattern-textile.png",
    truth: "pattern-source.svg",
    shots: [
      // A 1px hairline wave plus small dots at full zoom.
      { name: "hairline", box: { x: 700, y: 40, w: 150, h: 150 }, zoom: 8 },
      // Motif, rotated square outline, dots.
      { name: "motif", box: { x: 260, y: 90, w: 150, h: 150 }, zoom: 8 },
    ],
  },
];

const wanted = process.argv.slice(2).filter((a): a is PresetId => (PRESET_IDS as readonly string[]).includes(a));
await mkdir(OUT_SVG, { recursive: true });
await mkdir(OUT_EV, { recursive: true });

const report: unknown[] = [];

for (const c of CASES) {
  if (wanted.length && !wanted.includes(c.preset)) continue;
  const bytes = await readFile(`${FIX}/${c.fixture}`);
  const res = await traceImage(bytes, { preset: c.preset, detail: 0.5 });
  await writeFile(`${OUT_SVG}/${c.preset}.svg`, res.svg, "utf8");
  const truthSvg = c.truth ? await readFile(`${FIX}/${c.truth}`, "utf8") : null;
  const src = await rasteriseImage(bytes, 1);
  // device px per traced-SVG user unit, so the render scales exactly like the source
  const tracedScale = (src.width / res.width) * 1;

  const structural = {
    preset: c.preset,
    fixture: c.fixture,
    sourceSize: `${String(src.width)}x${String(src.height)}`,
    width: res.width,
    height: res.height,
    pathElements: (res.svg.match(/<path\b/g) ?? []).length,
    contours: res.pathCount,
    curves: (res.svg.match(/C/g) ?? []).length,
    colours: res.colourCount,
    bytes: res.bytes,
    ms: res.ms,
    imageElements: (res.svg.match(/<image\b/g) ?? []).length,
    base64: /base64/.test(res.svg),
    viewBox: /viewBox="0 0 \d+ \d+"/.exec(res.svg)?.[0] ?? null,
    widthAttr: /width="(\d+)"/.exec(res.svg)?.[1] ?? null,
    heightAttr: /height="(\d+)"/.exec(res.svg)?.[1] ?? null,
    nanOrInfinity: /NaN|Infinity/.test(res.svg),
    steps: res.steps,
  };

  // One render of the traced SVG per distinct zoom, shared by all its shots.
  const rendered = new Map<number, Raw>();
  const tracedAt = async (zoom: number) => {
    let r = rendered.get(zoom);
    if (!r) {
      r = await rasterise(res.svg, zoom * tracedScale);
      rendered.set(zoom, r);
    }
    return r;
  };

  const shots: unknown[] = [];
  for (const shot of c.shots) {
    const deviceBox: Box = {
      x: shot.box.x * shot.zoom,
      y: shot.box.y * shot.zoom,
      w: shot.box.w * shot.zoom,
      h: shot.box.h * shot.zoom,
    };
    const traced = await tracedAt(shot.zoom);
    const panels = [
      {
        img: await cropSmooth(bytes, shot.box, shot.zoom),
        label: `ORIGINAL RASTER · same crop · ${String(shot.zoom * 100)}%`,
      },
      {
        img: cropDevice(traced, deviceBox),
        label: `TRACED SVG · same crop · ${String(shot.zoom * 100)}%`,
      },
    ];
    let measurement: Record<string, number | string> = {};
    if (truthSvg) {
      const truth = await rasterise(truthSvg, shot.zoom);
      const raster = await rasteriseImage(bytes, shot.zoom, "lanczos3");
      const diag = shot.diagonal
        ? { y0: 8, y1: deviceBox.h - 8, xAt: (y: number) => y, halfWidth: Math.round(48 * (shot.zoom / 8)) }
        : undefined;
      const t = score(truth, traced, deviceBox, { diagonal: diag });
      const r0 = score(truth, raster, deviceBox, { diagonal: diag });
      measurement = {
        tracedMeanPx: +t.meanPx.toFixed(3),
        tracedP95Px: +t.p95Px.toFixed(3),
        tracedIou: +t.iou.toFixed(3),
        tracedStraightRmsPx: t.straightRmsPx === undefined || Number.isNaN(t.straightRmsPx) ? "n/a" : +t.straightRmsPx.toFixed(3),
        rasterMeanPx: +r0.meanPx.toFixed(3),
        rasterP95Px: +r0.p95Px.toFixed(3),
        rasterIou: +r0.iou.toFixed(3),
        rasterStraightRmsPx: Number.isNaN(r0.straightRmsPx) ? "n/a" : +r0.straightRmsPx.toFixed(3),
        straightRows: t.rows,
      };
    } else {
      panels.unshift({
        img: await cropNearest(bytes, shot.box, shot.zoom),
        label: `ORIGINAL RASTER · same crop · ${String(shot.zoom * 100)}% (actual pixels)`,
      });
    }
    const out = `${OUT_EV}/${c.preset}-${shot.name}-${String(shot.zoom * 100)}.png`;
    await save(out, await compose(panels));
    shots.push({ shot: shot.name, zoom: shot.zoom, box: shot.box, file: out, measurement });
  }

  report.push({ ...structural, shots });
  console.log(
    `${c.preset}: ${String(structural.contours)} contours ${String(structural.curves)} curves in ${String(structural.pathElements)} paths, ${String(structural.colours)} colours, ${String((res.bytes / 1024).toFixed(0))}KB, ${String(res.ms)}ms, img=${String(structural.imageElements)} b64=${String(structural.base64)} vb=${String(structural.viewBox)}`,
  );
  for (const s of shots) console.log("   ", JSON.stringify(s));
}

await writeFile(`${LAB}/metrics.json`, JSON.stringify(report, null, 2), "utf8");
console.log(`wrote ${LAB}/metrics.json`);

function cropDevice(img: Raw, box: Box): Raw {
  const w = Math.round(box.w);
  const h = Math.round(box.h);
  const out = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.round(box.y) + y);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.round(box.x) + x);
      const s = (sy * img.width + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = img.data[s];
      out[d + 1] = img.data[s + 1];
      out[d + 2] = img.data[s + 2];
      out[d + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}
