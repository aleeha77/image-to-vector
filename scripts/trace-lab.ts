/**
 * Tracecraft trace lab — evidence and measurement for the four presets.
 *
 * For every preset it:
 *   1. traces its fixture with the real engine;
 *   2. saves the .svg and asserts it is genuinely vector (no <image>, no base64,
 *      no NaN coordinates, a viewBox that matches its own width/height);
 *   3. scores the whole-image shape agreement against the source — IoU of the
 *      ink masks, and mean absolute colour error per channel;
 *   4. renders it at high zoom (500–800%) and writes a side-by-side crop against
 *      the original raster (the same crop, the same zoom);
 *   5. scores each crop: mean / p95 outline distance in source px, ink IoU, the
 *      straightness residual of a 45-degree edge (the staircase detector) and the
 *      radial residual of a known circle (the curvature-wobble detector) —
 *      reporting what the *raster itself* scores on the same measures as a floor.
 *
 * Usage: bun scripts/trace-lab.ts [preset ...]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { PRESET_IDS, traceImage, type PresetId } from "../src/trace.server";
import {
  type Box,
  type Raw,
  compose,
  cropNearest,
  cropSmooth,

  radialResidual,
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
  /** Set when the crop crosses a known circular stroke (source px). */
  circle?: { cx: number; cy: number; r: number; band: number };
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
      // The r=180 circle, on a 2.4px stroke: curvature.
      { name: "curve", box: { x: 400, y: 110, w: 130, h: 130 }, zoom: 8, circle: { cx: 300, cy: 285, r: 180, band: 6 } },
      // 2px strokes plus small text: hairlines and detail.
      { name: "hairlines", box: { x: 620, y: 170, w: 130, h: 130 }, zoom: 8 },
    ],
  },
  {
    preset: "logo",
    fixture: "logo-flat.png",
    truth: "logo-source.svg",
    shots: [
      // Circle / half-disc borders: flat hard edges meeting curves, and the
      // boundary where red, green, yellow and paper all meet.
      { name: "circle", box: { x: 490, y: 320, w: 160, h: 160 }, zoom: 7 },
      // The wordmark over the hexagon: sharp glyph corners.
      { name: "text", box: { x: 430, y: 230, w: 150, h: 150 }, zoom: 7 },
      // Paper/hexagon/ring junctions: colour coverage at the edges.
      { name: "coverage", box: { x: 130, y: 330, w: 160, h: 160 }, zoom: 6 },
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
  const tracedScale = src.width / res.width;

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
    base64: /base64/i.test(res.svg),
    viewBox: /viewBox="0 0 \d+ \d+"/.exec(res.svg)?.[0] ?? null,
    widthAttr: /width="(\d+)"/.exec(res.svg)?.[1] ?? null,
    heightAttr: /height="(\d+)"/.exec(res.svg)?.[1] ?? null,
    nanOrInfinity: /NaN|Infinity/.test(res.svg),
    steps: res.steps,
  };
  const assertions = {
    vectorNotBitmap: structural.imageElements === 0 && !structural.base64,
    viewBoxMatches: structural.viewBox === `viewBox="0 0 ${String(res.width)} ${String(res.height)}"`,
    noNan: !structural.nanOrInfinity,
    curveBased: structural.curves > 0,
  };

  // --- whole-image agreement with the source ---------------------------
  const wholeTruth = truthSvg ? await rasterise(truthSvg, 1) : src;
  const wholeBox: Box = { x: 0, y: 0, w: wholeTruth.width, h: wholeTruth.height };
  const wholeTraced = await rasterise(res.svg, tracedScale);
  const whole = score(wholeTruth, wholeTraced, wholeBox);
  // Unpainted canvas: pixels no path covers. A hole or a gap between layers
  // shows up here — the failure mode that turns zoomed art into hairlines.
  let unpainted = 0;
  for (let i = 3; i < wholeTraced.data.length; i += 4) if (wholeTraced.data[i] < 8) unpainted++;
  const unpaintedFrac = unpainted / (wholeTraced.width * wholeTraced.height);
  let colourErr: number | null = null;
  {
    // Mean absolute per-channel difference against the source raster: flat art
    // should be a couple of levels, a photograph tens of levels.
    const t = wholeTruth;
    const g = wholeTraced;
    let sum = 0;
    let n = 0;
    const h = Math.min(t.height, g.height);
    const w = Math.min(t.width, g.width);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * t.width + x) * 4;
        const j = (y * g.width + x) * 4;
        const a = t.data[i + 3] / 255;
        const b = g.data[j + 3] / 255;
        // composite both over white so alpha cannot flatter either one
        for (let k = 0; k < 3; k++) {
          sum += Math.abs((t.data[i + k] * a + 255 * (1 - a)) - (g.data[j + k] * b + 255 * (1 - b)));
          n++;
        }
      }
    }
    colourErr = +(sum / Math.max(1, n)).toFixed(2);
  }

  // Whole-image side-by-side, so a missing layer cannot hide in a 150px crop.
  {
    await save(
      `${OUT_EV}/full-${c.preset}.png`,
      await compose([
        { img: await shrinkToFit(bytes, 620), label: `ORIGINAL RASTER · whole image · ${String(src.width)}x${String(src.height)}` },
        { img: await shrinkToFit(res.svg, 620, true), label: `TRACED SVG · whole image · ${String(res.width)}x${String(res.height)}` },
      ]),
    );
  }

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
    let measurement: Record<string, number | string | null> = {};
    if (truthSvg) {
      const truth = await rasterise(truthSvg, shot.zoom);
      const raster = await rasteriseImage(bytes, shot.zoom, "lanczos3");
      const diag = shot.diagonal
        ? { y0: 8, y1: deviceBox.h - 8, xAt: (y: number) => y, halfWidth: Math.round(48 * (shot.zoom / 8)) }
        : undefined;
      const t = score(truth, traced, deviceBox, { diagonal: diag });
      const r0 = score(truth, raster, deviceBox, { diagonal: diag });
      const rt = shot.circle ? radialResidual(truth, deviceBox, shot.circle, shot.zoom) : null;
      const rg = shot.circle ? radialResidual(traced, deviceBox, shot.circle, shot.zoom) : null;
      const rr = shot.circle ? radialResidual(raster, deviceBox, shot.circle, shot.zoom) : null;
      measurement = {
        tracedMeanPx: +t.meanPx.toFixed(3),
        tracedP95Px: +t.p95Px.toFixed(3),
        tracedIou: +t.iou.toFixed(3),
        tracedStraightRmsPx: Number.isFinite(t.straightRmsPx) ? +t.straightRmsPx.toFixed(3) : "n/a",
        rasterMeanPx: +r0.meanPx.toFixed(3),
        rasterP95Px: +r0.p95Px.toFixed(3),
        rasterIou: +r0.iou.toFixed(3),
        rasterStraightRmsPx: Number.isFinite(r0.straightRmsPx) ? +r0.straightRmsPx.toFixed(3) : "n/a",
        straightRows: t.rows,
        tracedRadialRmsPx: rg ? +rg.rmsPx.toFixed(3) : null,
        tracedRadialP95Px: rg ? +rg.p95Px.toFixed(3) : null,
        truthRadialRmsPx: rt ? +rt.rmsPx.toFixed(3) : null,
        rasterRadialRmsPx: rr ? +rr.rmsPx.toFixed(3) : null,
      };
    } else {
      // No vector ground truth for the photograph: show the actual pixels too,
      // so a viewer can tell smoothing from a lost feature.
      panels.unshift({
        img: await cropNearest(bytes, shot.box, shot.zoom),
        label: `ORIGINAL RASTER · same crop · ${String(shot.zoom * 100)}% (actual pixels)`,
      });
    }
    const out = `${OUT_EV}/${c.preset}-${shot.name}-${String(shot.zoom * 100)}.png`;
    await save(out, await compose(panels));
    shots.push({ shot: shot.name, zoom: shot.zoom, box: shot.box, file: out, measurement });
  }

  report.push({
    ...structural,
    assertions,
    whole: {
      iou: +whole.iou.toFixed(4),
      meanBoundaryPx: +whole.meanPx.toFixed(3),
      p95BoundaryPx: +whole.p95Px.toFixed(3),
      colourMeanAbsErr: colourErr,
      unpaintedFraction: +unpaintedFrac.toFixed(6),
    },
    shots,
  });
  console.log(
    `${c.preset}: ${String(structural.contours)} contours ${String(structural.curves)} curves in ${String(structural.pathElements)} paths, ${String(structural.colours)} colours, ${String((res.bytes / 1024).toFixed(0))}KB, ${String(res.ms)}ms | whole IoU ${whole.iou.toFixed(3)} mean ${whole.meanPx.toFixed(2)}px p95 ${whole.p95Px.toFixed(2)}px colourErr ${String(colourErr)} | unpainted ${String((unpaintedFrac * 100).toFixed(4))}% | img=${String(structural.imageElements)} b64=${String(structural.base64)} ${JSON.stringify(assertions)}`,
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
      // Composite over white, exactly as a browser shows an SVG: an unpainted
      // gap then reads as white paper rather than as a black artefact.
      const a = img.data[s + 3] / 255;
      for (let k = 0; k < 3; k++) out[d + k] = Math.round(img.data[s + k] * a + 255 * (1 - a));
      out[d + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/* --- whole-image panel helper --- */

/** Shrink an input (image bytes or an SVG string) so its long edge is `edge` px. */
async function shrinkToFit(input: Buffer | string, edge: number, svg = false): Promise<Raw> {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  const opts = svg ? { density: 72 } : {};
  const meta = await sharp(buf, opts).metadata();
  const scale = edge / Math.max(meta.width ?? 1, meta.height ?? 1);
  let pipe = sharp(buf, opts).resize(
    Math.max(1, Math.round((meta.width ?? 1) * scale)),
    Math.max(1, Math.round((meta.height ?? 1) * scale)),
    { kernel: "lanczos3", fit: "fill" },
  );
  // Composite over white so transparency cannot be mistaken for a lost layer.
  if (svg) pipe = pipe.flatten({ background: "#ffffff" });
  const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
